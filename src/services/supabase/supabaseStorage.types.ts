import type { SupabaseClient } from '@supabase/supabase-js';

export interface CreateSupabaseServiceClientArgs {
  url: string;
  serviceKey: string;
}

export interface UploadFileToStorageArgs {
  client: SupabaseClient;
  bucket: string;
  /** Path inside the bucket, e.g. `trades/2026-09-25/BTCUSDT-entry.png`. */
  path: string;
  content: Buffer;
  /** e.g. `image/png`. Without it Storage stores a Buffer as `text/plain;charset=UTF-8`. */
  contentType: string;
  /** Overwrite an existing object at `path`. Keep it TRUE for anything retried: when an upload landed
   *  but its answer was lost, the retry of a non-upsert upload is refused as "already exists". */
  isUpsert: boolean;
  /** When set, a signed link valid for this many seconds is created too (private bucket). */
  signedUrlExpiresInSeconds?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export type UploadFileToStorageResult =
  | {
      isUploaded: true;
      /** Path inside the bucket, as Storage returned it. */
      path: string;
      /** `bucket/path`. */
      fullPath: string;
      /** Built locally from the project URL — reachable only when the bucket is public. */
      publicUrl: string;
      /** Null when not asked for, or when creating it failed (the upload itself still succeeded). */
      signedUrl: string | null;
    }
  | {
      isUploaded: false;
      errorText: string;
    };
