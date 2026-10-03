import type { SupabaseClient } from '@supabase/supabase-js';

import { createSupabaseServiceClient, uploadFileToStorage } from '../src/services/supabase/supabaseStorage';

const mockCreateClient = jest.fn((url: string, key: string) => ({ url, key }));

jest.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string) => mockCreateClient(url, key),
}));

type StorageAnswer<T> = { data: T; error: null } | { data: null; error: { message: string } };

interface FakeBucket {
  upload: jest.Mock;
  getPublicUrl: jest.Mock;
  createSignedUrl: jest.Mock;
}

// Answer shapes follow the installed @supabase/storage-js typings (StorageFileApi.upload /
// getPublicUrl / createSignedUrl) — no live call was made.
function makeClient(uploadAnswerList: StorageAnswer<{ id: string; path: string; fullPath: string }>[], signedAnswer?: StorageAnswer<{ signedUrl: string }>): { client: SupabaseClient; bucket: FakeBucket; from: jest.Mock } {
  const upload = jest.fn();

  for (const answer of uploadAnswerList) {
    upload.mockResolvedValueOnce(answer);
  }

  const bucket: FakeBucket = {
    upload,
    getPublicUrl: jest.fn((path: string) => ({ data: { publicUrl: `https://example.supabase.co/storage/v1/object/public/charts/${path}` } })),
    createSignedUrl: jest.fn().mockResolvedValue(signedAnswer ?? { data: { signedUrl: 'https://signed' }, error: null }),
  };
  const from = jest.fn(() => bucket);

  return { client: { storage: { from } } as unknown as SupabaseClient, bucket, from };
}

const OK_UPLOAD = { data: { id: 'obj-1', path: 'trades/a.png', fullPath: 'charts/trades/a.png' }, error: null };

describe('createSupabaseServiceClient', () => {
  it('builds the client from url and service key', () => {
    createSupabaseServiceClient({ url: 'https://example.supabase.co', serviceKey: 'service_key' });

    expect(mockCreateClient).toHaveBeenCalledWith('https://example.supabase.co', 'service_key');
  });
});

describe('uploadFileToStorage', () => {
  it('uploads with content type and upsert, and returns path info with the public link', async () => {
    const { client, bucket, from } = makeClient([OK_UPLOAD]);
    const content = Buffer.from('png-bytes');

    const result = await uploadFileToStorage({ client, bucket: 'charts', path: 'trades/a.png', content, contentType: 'image/png', isUpsert: true, retryBaseDelayMs: 1 });

    expect(from).toHaveBeenCalledWith('charts');
    expect(bucket.upload).toHaveBeenCalledWith('trades/a.png', content, { contentType: 'image/png', upsert: true });
    expect(result).toEqual({
      isUploaded: true,
      path: 'trades/a.png',
      fullPath: 'charts/trades/a.png',
      publicUrl: 'https://example.supabase.co/storage/v1/object/public/charts/trades/a.png',
      signedUrl: null,
    });
    expect(bucket.createSignedUrl).not.toHaveBeenCalled();
  });

  it('retries a failed upload and succeeds on a later attempt', async () => {
    const { client, bucket } = makeClient([{ data: null, error: { message: 'gateway timeout' } }, OK_UPLOAD]);

    const result = await uploadFileToStorage({ client, bucket: 'charts', path: 'trades/a.png', content: Buffer.from('x'), contentType: 'image/png', isUpsert: true, retryBaseDelayMs: 1 });

    expect(bucket.upload).toHaveBeenCalledTimes(2);
    expect(result.isUploaded).toBe(true);
  });

  it('returns the error text instead of throwing when every attempt fails', async () => {
    const failed = { data: null, error: { message: 'The resource already exists' } };
    const { client, bucket } = makeClient([failed, failed, failed]);

    const result = await uploadFileToStorage({ client, bucket: 'charts', path: 'trades/a.png', content: Buffer.from('x'), contentType: 'image/png', isUpsert: false, retryBaseDelayMs: 1 });

    expect(bucket.upload).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ isUploaded: false, errorText: 'The resource already exists' });
  });

  it('returns a thrown network error as a result too', async () => {
    const { client, bucket } = makeClient([]);
    bucket.upload.mockRejectedValue(new Error('fetch failed'));

    const result = await uploadFileToStorage({ client, bucket: 'charts', path: 'trades/a.png', content: Buffer.from('x'), contentType: 'image/png', isUpsert: true, retryBaseDelayMs: 1 });

    expect(result).toEqual({ isUploaded: false, errorText: 'fetch failed' });
  });

  it('creates a signed link when asked for', async () => {
    const { client, bucket } = makeClient([OK_UPLOAD], { data: { signedUrl: 'https://example.supabase.co/signed?token=t' }, error: null });

    const result = await uploadFileToStorage({ client, bucket: 'charts', path: 'trades/a.png', content: Buffer.from('x'), contentType: 'image/png', isUpsert: true, signedUrlExpiresInSeconds: 3600, retryBaseDelayMs: 1 });

    expect(bucket.createSignedUrl).toHaveBeenCalledWith('trades/a.png', 3600);
    expect(result.isUploaded && result.signedUrl).toBe('https://example.supabase.co/signed?token=t');
  });

  it('keeps the upload a success when only the signed link fails', async () => {
    const { client } = makeClient([OK_UPLOAD], { data: null, error: { message: 'denied' } });

    const result = await uploadFileToStorage({ client, bucket: 'charts', path: 'trades/a.png', content: Buffer.from('x'), contentType: 'image/png', isUpsert: true, signedUrlExpiresInSeconds: 60, retryBaseDelayMs: 1, maxRetries: 1 });

    expect(result.isUploaded).toBe(true);
    expect(result.isUploaded && result.signedUrl).toBeNull();
  });
});
