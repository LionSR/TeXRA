import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import { uploadInlineInputFiles } from '@agent/modelHandlers/openai/openAIResponseFileUploads';
import type OpenAI from 'openai';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

interface TestInputFile {
  type: 'input_file';
  filename?: string;
  file_data?: string;
  file_id?: string;
}

function inputFileMessage(fileData: string): {
  content: TestInputFile;
  message: ResponseInputItem;
} {
  const content: TestInputFile = {
    type: 'input_file',
    filename: 'paper.pdf',
    file_data: fileData,
  };
  return {
    content,
    message: {
      type: 'message',
      role: 'user',
      content: [content],
    } as unknown as ResponseInputItem,
  };
}

function uploadClient(): {
  client: OpenAI;
  create: ReturnType<typeof vi.fn>;
  uploadedBytes: () => Buffer | undefined;
} {
  let bytes: Buffer | undefined;
  const create = vi.fn(async ({ file }: { file: File }) => {
    bytes = Buffer.from(await file.arrayBuffer());
    return { id: 'file-1' };
  });
  return {
    client: { files: { create } } as unknown as OpenAI,
    create,
    uploadedBytes: () => bytes,
  };
}

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
} as unknown as AgentTrace;

async function upload(client: OpenAI, message: ResponseInputItem) {
  await uploadInlineInputFiles(client, [message], {
    openRouterRouting: false,
    logger,
  });
}

describe('uploadInlineInputFiles data URLs', () => {
  it('decodes parameters and percent-encoded base64 padding', async () => {
    const { content, message } = inputFileMessage(
      'data:application/pdf;charset=utf-8;base64,SGVsbG8%3D',
    );
    const { client, uploadedBytes } = uploadClient();

    await upload(client, message);

    expect(uploadedBytes()?.toString()).toBe('Hello');
    expect(content).toEqual({ type: 'input_file', file_id: 'file-1' });
  });

  it('preserves the raw-base64 fallback', async () => {
    const { message } = inputFileMessage('SGVsbG8=');
    const { client, uploadedBytes } = uploadClient();

    await upload(client, message);

    expect(uploadedBytes()?.toString()).toBe('Hello');
  });

  it('rejects malformed data URLs without mutating the input', async () => {
    const fileData = 'data:application/pdf;base64';
    const { content, message } = inputFileMessage(fileData);
    const { client, create } = uploadClient();

    await expect(upload(client, message)).rejects.toThrow(TypeError);
    expect(create).not.toHaveBeenCalled();
    expect(content).toEqual({
      type: 'input_file',
      filename: 'paper.pdf',
      file_data: fileData,
    });
  });

  it('uploads an empty data URL payload', async () => {
    const { message } = inputFileMessage('data:application/pdf;base64,');
    const { client, uploadedBytes } = uploadClient();

    await upload(client, message);

    expect(uploadedBytes()).toHaveLength(0);
  });
});
