// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import type { Part, UploadFileParameters } from '@google/genai';
import { createPartFromUri } from '@google/genai';

// Local imports - agent
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/modelHandlerGoogleGenAI';
import { MediaEntry } from '@agent/utils/mediaTypes';
import type { AgentLogger } from '@logger/AgentLogger';

// Local imports - model config
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
} from '@model/ModelConfig';

interface LoggerStub extends Partial<AgentLogger> {
  channelId: string;
  fileListEntries: Array<Array<{ path: string; ok: boolean }>>;
}

function createLoggerStub(): AgentLogger {
  const stub: LoggerStub = {
    channelId: 'test-channel',
    fileListEntries: [],
    debug: () => {
      /* no-op for tests */
    },
    info: () => {
      /* no-op for tests */
    },
    warn: () => {
      /* no-op for tests */
    },
    error: () => {
      /* no-op for tests */
    },
    fileList(entries: Array<{ path: string; ok: boolean }>) {
      this.fileListEntries.push(entries);
    },
    getActiveGroupId: () => undefined,
  };

  return stub as unknown as AgentLogger;
}

function buildGoogleConfig(
  overrides: Partial<ModelCapabilities> = {},
): ModelConfig {
  const capabilities: ModelCapabilities = {
    ...DEFAULT_MODEL_CAPABILITIES,
    supportsVision: true,
    supportsNativePdf: true,
    ...overrides,
  };

  return {
    name: 'test-google',
    fullName: 'test-google',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 100000,
    capabilities,
    openRouterOnly: false,
  };
}

class GoogleHandlerTestDouble extends ModelHandlerGoogleGenAI {
  constructor(
    config: ModelConfig,
    private readonly clientStub: any,
  ) {
    super(config);
  }

  override async getClient(): Promise<any> {
    return this.clientStub;
  }

  async invokeUpload(entries: MediaEntry[]): Promise<Part[]> {
    return this.uploadMediaEntries(entries);
  }
}

describe('ModelHandlerGoogleGenAI media uploads', () => {
  it('uploads MediaEntry instances via files.upload and returns URI parts', async () => {
    const uploadCalls: UploadFileParameters[] = [];

    const clientStub = {
      files: {
        upload: async (params: UploadFileParameters) => {
          uploadCalls.push(params);
          return {
            name: 'files/test-file',
            uri: 'files/test-file',
            mimeType: params.config?.mimeType ?? 'application/pdf',
            displayName: params.config?.displayName ?? 'test.pdf',
          };
        },
      },
    };

    const handler = new GoogleHandlerTestDouble(
      buildGoogleConfig(),
      clientStub,
    );
    handler.setLogger(createLoggerStub());

    const binaryPayload = Buffer.from('%PDF-1.7');
    const entry: MediaEntry = {
      file_name: 'sample.pdf',
      data: binaryPayload.toString('base64'),
      binaryData: new Uint8Array(binaryPayload),
      media_type: 'application/pdf',
      media_category: 'image',
    };

    const parts = await handler.invokeUpload([entry]);

    assert.equal(uploadCalls.length, 1, 'should invoke files.upload once');
    const [uploadParams] = uploadCalls;
    assert.ok(
      uploadParams.file instanceof globalThis.Blob,
      'file payload should be a Blob',
    );
    assert.equal(uploadParams.config?.mimeType, 'application/pdf');
    assert.equal(uploadParams.config?.displayName, 'sample.pdf');

    const blobBuffer = Buffer.from(
      await (uploadParams.file as Blob).arrayBuffer(),
    );
    assert.equal(
      blobBuffer.equals(binaryPayload),
      true,
      'blob payload should match provided binary data',
    );

    assert.deepEqual(parts, [
      createPartFromUri('files/test-file', 'application/pdf'),
    ]);
  });
});
