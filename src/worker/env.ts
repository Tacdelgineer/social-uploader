export interface Env {
  ASSETS: Fetcher;
  UPLOADS: R2Bucket;
  METADATA: KVNamespace;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  APP_BASE_URL: string;
  YOUTUBE_CLIENT_ID: string;
  YOUTUBE_CLIENT_SECRET: string;
  META_APP_ID: string;
  META_APP_SECRET: string;
  TIKTOK_CLIENT_KEY: string;
  TIKTOK_CLIENT_SECRET: string;
  OAUTH_ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
}
