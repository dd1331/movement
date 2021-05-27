import {
  Injectable,
  HttpException,
  HttpStatus,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Like as TLike } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Post } from './entities/post.entity';
import { CreatePostDto } from './dto/create-post.dto';
import { Repository, Between, In, FindManyOptions } from 'typeorm';
import { UpdatePostDto } from './dto/update-post.dto';
import { Like } from '../like/entities/like.entity';
import { CreateLikeDto } from '../like/dto/create-like-dto';
import { UsersService } from '../users/users.service';
import { HashtagsService } from '../hashtags/hashtags.service';
// import { CacheService } from '../cache/cache.service';
import { File } from '../files/entities/file.entity';
import * as dayjs from 'dayjs';
import { GetPostsDto } from './dto/get-posts.dto';
import { RecommendedPost } from './entities/recommended_post.entity';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class PostsService {
  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    @InjectRepository(Like) private readonly likeRepo: Repository<Like>,
    @InjectRepository(File) private readonly fileRepo: Repository<File>,
    @InjectRepository(RecommendedPost)
    private readonly recommendedPost: Repository<RecommendedPost>,
    private readonly usersService: UsersService,
    private readonly hashtagsService: HashtagsService, // private readonly cacheService: CacheService,
  ) {}
  private readonly logger = new Logger(PostsService.name);

  async createPost(dto: CreatePostDto): Promise<Post> {
    const newPost = await this.postRepo.create(dto);

    await this.postRepo.save(newPost);

    if (!newPost)
      throw new HttpException('글 작성에 실패했습니다', HttpStatus.BAD_REQUEST);

    // TODO add to other methods
    if (dto.hashtags) await this.hashtagsService.create(newPost, dto);

    if (dto.fileId) {
      const newFiles = await this.fileRepo.find({ where: { id: dto.fileId } });
      newPost.files = newFiles;
    }

    await this.postRepo.save(newPost);

    return newPost;
  }
  async createPostByWingman(dto: CreatePostDto): Promise<Post> {
    const post: Post = await this.postRepo.create(dto);

    await this.postRepo.save(post);

    return post;
  }
  async getPost(id: number): Promise<Post> {
    //TODO exclude softdeleted likes
    const post = await this.postRepo.findOne(id, {
      relations: ['poster', 'comments', 'comments.commenter', 'likes', 'files'],
    });

    if (!post) {
      throw new HttpException(
        '존재하지 않는 게시글입니다',
        HttpStatus.NOT_FOUND,
      );
    }

    await this.postRepo.save(post);

    return post;
  }
  async readPost(id: number): Promise<Post> {
    const post = await this.getPost(id);

    post.views += 1;

    return await this.postRepo.save(post);
  }
  async getPosts(dto: GetPostsDto): Promise<Post[]> {
    // TODO find better way of setting default when dto used
    const take = dto.take ? dto.take : 20;
    const skip = dto.page ? (dto.page - 1) * take : 0;
    const where = dto.category ? { category: dto.category } : {};

    if (dto.hashtagId || dto.hashtagTitle) {
      const postIds: number[] = await this.hashtagsService.getPostIdsByHashtag(
        dto.hashtagId ? dto.hashtagId : dto.hashtagTitle,
        dto.hashtagId ? 'hashtagId' : 'postId',
      );
      where['id'] = In(postIds);
    }

    const posts = await this.postRepo.find({
      where,
      relations: ['poster', 'comments', 'files'],
      order: {
        createdAt: 'DESC',
      },
      take,
      skip,
    });

    return posts;
  }
  async getPostsWithKeyword(dto: GetPostsDto): Promise<Post[]> {
    if (!dto.keyword) throw new BadRequestException();
    // TODO seperate search options
    // there must be a better way of using like function
    const take = dto.take ? dto.take : 20;
    const skip = dto.page ? (dto.page - 1) * take : 0;
    const posts = await this.postRepo.find({
      where: [
        { title: TLike(`%${dto.keyword}%`) },
        { title: TLike(`${dto.keyword}%`) },
        { title: TLike(`$${dto.keyword}`) },
        { content: TLike(`%${dto.keyword}%`) },
        { content: TLike(`${dto.keyword}%`) },
        { content: TLike(`$${dto.keyword}`) },
      ],
      take,
      skip,
    });

    return posts;
  }

  async getRecentPosts(): Promise<Post[]> {
    const findOptions: FindManyOptions<Post> = {
      relations: ['poster', 'comments', 'files'],
      take: 5,
      order: { createdAt: 'DESC' },
    };

    return await this.getCachedOrNormalPosts('recentPosts', findOptions);
  }
  async getPopularPosts(): Promise<Post[]> {
    const findOptions: FindManyOptions<Post> = {
      where: {
        createdAt: Between(dayjs().subtract(7, 'd').toDate(), dayjs().toDate()),
      },
      relations: ['comments'],
      order: { views: 'DESC' },
      take: 5,
    };

    return await this.getCachedOrNormalPosts('popularPosts', findOptions);
  }
  async getRecommendedPosts(): Promise<Post[]> {
    // const cachedRecommendedPosts: Post[] = await this.getCached(
    //   'recommendedPosts',
    // );
    // if (cachedRecommendedPosts) return cachedRecommendedPosts;

    const postIds: number[] = await this.getRecommendedPostIds();
    const findOptions: FindManyOptions<Post> = {
      where: { id: In(postIds) },
      order: { likeCount: 'DESC' },
      relations: ['files'],
      take: 6,
    };

    return await this.getCachedOrNormalPosts('recommendedPosts', findOptions);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async setRecommendedPosts(): Promise<void> {
    // MEMO cron runs twice when this service is provided to other module
    this.logger.debug(
      `setRecommendedPosts started ${PostsService.name} ${Date.now()}`,
    );
    const postIds: number[] = await this.getPostIdsWithImage();
    const postsWithImage: Post[] = await this.getPostsWithImage(postIds);
    await Promise.all(
      postsWithImage.map(async (post) => {
        const exist = await this.recommendedPost.findOne({
          where: { postId: post.id },
        });
        if (exist) {
          exist.updatedAt = dayjs().toDate();
          await this.recommendedPost.save(exist);
        } else {
          const recommendedPost = await this.recommendedPost.create({
            postId: post.id,
          });
          await this.recommendedPost.save(recommendedPost);
        }
      }),
    );
  }
  async getPostsWithImage(ids): Promise<Post[]> {
    return await this.postRepo.find({
      where: { id: In(ids) },
      order: { likeCount: 'DESC', createdAt: 'DESC' },
      take: 6,
    });
  }
  async getRecommendedPostIds(): Promise<number[]> {
    const posts = await this.recommendedPost.find({
      order: { updatedAt: 'DESC' },
      take: 6,
    });
    return posts.map((post) => {
      return post.postId;
    });
  }

  async getPostIdsWithImage(): Promise<number[]> {
    const files: File[] = await this.fileRepo.find({
      where: {
        createdAt: Between(
          dayjs().subtract(10, 'd').toDate(),
          dayjs().toDate(),
        ),
      },
    });
    const postIds = files.map((file) => file.postId);
    return postIds;
  }
  async getEmphasizedPosts(dto: GetPostsDto): Promise<Post[]> {
    const findOptions: FindManyOptions<Post> = {
      where: {
        // TODO add created filter
        category: dto.category,
      },
      order: { likeCount: 'DESC' },
      take: 5,
    };

    return await this.postRepo.find(findOptions);
  }
  async getCachedOrNormalPosts(
    key: string,
    findOptions: FindManyOptions<Post>,
  ): Promise<Post[]> {
    // MEMO commented out cause of heroku redis issue.
    // free plan is barely usable
    // const cashedPosts: Post[] = await this.getCached(key);

    // if (cashedPosts) return cashedPosts;
    const posts = await this.postRepo.find(findOptions);

    // await this.cacheService.set(key, posts);

    return posts;
  }
  // async getCached<T>(key: string): Promise<T[] | null> {
  //   const cashed: T[] = await this.cacheService.get(key);

  //   return cashed ? cashed : null;
  // }

  async updatePost(dto: UpdatePostDto): Promise<Post> {
    const { title, content } = dto;
    const existingPost = await this.getPost(dto.id);

    if (!existingPost) return;

    const newFiles = await this.fileRepo.find({ where: { id: dto.fileId } });
    existingPost.title = title;
    existingPost.content = content;
    existingPost.files = newFiles;
    const updatedPost = await this.postRepo.save(existingPost);

    return updatedPost;
  }
  async deletePost(postId: number): Promise<Post> {
    // TODO softdelete related comments
    const post = await this.getPost(postId);

    if (!post) return;

    post.deletedAt = new Date();
    await this.postRepo.save(post);

    return post;
  }

  async likeOrDislikePost(dto: CreateLikeDto): Promise<Like[]> {
    const post = await this.getPost(dto.targetId);

    if (!post) return;

    const like = await this.likeRepo.findOne({
      where: { post: { id: dto.targetId }, user: { id: dto.userId } },
    });

    if (!like) {
      await this.createLike(dto, post);
    }
    if (like) {
      await this.updateLikeCount(like, dto, post);
    }

    const likes = await this.likeRepo.find({
      where: { post: { id: dto.targetId } },
    });
    return likes;
  }
  async updateLikeCount(like: Like, dto: CreateLikeDto, post: Post) {
    const status: boolean | null = like.isLike;
    if (status === null && dto.isLike) {
      post.likeCount += 1;
      like.isLike = dto.isLike;
    }
    if (status === null && !dto.isLike) {
      post.dislikeCount += 1;
      like.isLike = dto.isLike;
    }
    if (status === true && dto.isLike) {
      post.likeCount -= 1;
      like.isLike = null;
    }
    if (status === true && !dto.isLike) {
      post.likeCount -= 1;
      post.dislikeCount += 1;
      like.isLike = dto.isLike;
    }
    if (status === false && dto.isLike) {
      post.likeCount += 1;
      post.dislikeCount -= 1;
      like.isLike = dto.isLike;
    }
    if (status === false && !dto.isLike) {
      post.dislikeCount -= 1;
      like.isLike = null;
    }
    await this.likeRepo.save(like);
    await this.postRepo.save(post);

    return like;
  }
  async createLike(dto: CreateLikeDto, post) {
    const user = await this.usersService.findOne(dto.userId);

    if (dto.isLike) post.likeCount += 1;
    if (!dto.isLike) post.dislikeCount += 1;

    await this.postRepo.save(post);
    const like = await this.likeRepo.create(dto);
    like.post = post;
    like.user = user;
    await this.likeRepo.save(like);

    return like;
  }
}
