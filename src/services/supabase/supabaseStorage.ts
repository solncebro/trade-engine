import { createClient, SupabaseClient } from '@supabase/supabase-js';

import type {
  CreateSupabaseServiceClientArgs,
  UploadFileToStorageArgs,
  UploadFileToStorageResult,
} from './supabaseStorage.types';

import { logger } from '../../core/logger';
import { withResultRetry } from '../../core/withRetryOn429';
import { describeError } from '../../utils/errorFormatter.utils';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/** The one way to build a server-side Supabase client from a service key — the same call the trade
 *  journal uses, so an app never imports supabase-js itself. */
export function createSupabaseServiceClient(args: CreateSupabaseServiceClientArgs): SupabaseClient {
  return createClient(args.url, args.serviceKey);
}

/**
 * Upload a file (a chart PNG, a report) to Supabase Storage with the library's retry. Errors are not
 * thrown — they come back as `errorText`, like an order result. Storage API per the installed
 * @supabase/storage-js typings: `storage.from(bucket).upload(path, body, { contentType, upsert })` →
 * `{ data: { id, path, fullPath } | null, error }`; `getPublicUrl(path)` is local, no request.
 */
export async function uploadFileToStorage(args: UploadFileToStorageArgs): Promise<UploadFileToStorageResult> {
  const bucketApi = args.client.storage.from(args.bucket);
  const maxRetries = args.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = args.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const contextLabel = `uploadFileToStorage ${args.bucket}/${args.path}`;

  try {
    const uploadResult = await withResultRetry({
      fn: async () => bucketApi.upload(args.path, args.content, { contentType: args.contentType, upsert: args.isUpsert }),
      contextLabel,
      maxRetries,
      baseDelayMs,
    });

    if (uploadResult.error !== null) {
      logger.error({ error: uploadResult.error, bucket: args.bucket, path: args.path }, `[SupabaseStorage] Upload failed after ${maxRetries} attempt(s)`);

      return { isUploaded: false, errorText: uploadResult.error.message };
    }

    const { publicUrl } = bucketApi.getPublicUrl(uploadResult.data.path).data;
    let signedUrl: string | null = null;

    if (args.signedUrlExpiresInSeconds !== undefined) {
      const expiresInSeconds = args.signedUrlExpiresInSeconds;
      const signedResult = await withResultRetry({
        fn: async () => bucketApi.createSignedUrl(uploadResult.data.path, expiresInSeconds),
        contextLabel: `${contextLabel} signed url`,
        maxRetries,
        baseDelayMs,
      });

      if (signedResult.error === null) {
        signedUrl = signedResult.data.signedUrl;
      } else {
        logger.warn({ error: signedResult.error, bucket: args.bucket, path: args.path }, '[SupabaseStorage] Uploaded, but creating the signed link failed');
      }
    }

    return {
      isUploaded: true,
      path: uploadResult.data.path,
      fullPath: uploadResult.data.fullPath,
      publicUrl,
      signedUrl,
    };
  } catch (error: unknown) {
    // A thrown error (network layer, not a Storage answer) — still a result, never an exception.
    logger.error({ error, bucket: args.bucket, path: args.path }, '[SupabaseStorage] Upload threw');

    return { isUploaded: false, errorText: describeError(error) };
  }
}
