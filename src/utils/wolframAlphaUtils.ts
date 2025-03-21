import * as vscode from 'vscode';

import axios from 'axios';
import { getApiKey } from './secretUtils';

interface WolframValves {
  WOLFRAM_APP_ID: string;
  API_BASE_URL: string;
  MAX_CHARS: number;
}

interface WolframResponse {
  status: string;
  data?: string;
  message?: string;
  url: string | null;
}

export class WolframAlphaClient {
  private valves: WolframValves;
  private appId: string;
  private apiBaseUrl: string;
  private maxChars: number;

  constructor() {
    this.valves = {
      WOLFRAM_APP_ID: '',
      API_BASE_URL: 'https://www.wolframalpha.com/api/v1/llm-api',
      MAX_CHARS: 6800,
    };

    this.appId = process.env.WOLFRAM_APP_ID || this.valves.WOLFRAM_APP_ID;
    this.apiBaseUrl = this.valves.API_BASE_URL;
    this.maxChars = this.valves.MAX_CHARS;
  }

  /**
   * Initialize the client with an API key
   */
  async initialize(): Promise<void> {
    try {
      this.appId = await getApiKey('wolfram');
    } catch (error) {
      console.error('Failed to get Wolfram Alpha API key:', error);
      throw error;
    }
  }

  /**
   * Perform a query to WolframAlpha LLM API
   * @param query The query to send to WolframAlpha
   * @param maxChars Maximum number of characters in the response (optional)
   * @param additionalParams Additional parameters to include in the API request
   * @returns A promise that resolves to the response data
   */
  async performQuery(
    query: string,
    maxChars?: number,
    additionalParams: Record<string, any> = {},
  ): Promise<WolframResponse> {
    try {
      const params = new URLSearchParams({
        input: query,
        appid: this.appId,
        maxchars: (maxChars || this.maxChars).toString(),
        ...additionalParams,
      });

      const url = `${this.apiBaseUrl}?${params.toString()}`;

      const headers = {
        'User-Agent': 'WolframAlphaAPI/1.1',
        Authorization: `Bearer ${this.appId}`,
      };

      const response = await axios.get(url, { headers, timeout: 120000 });

      return {
        status: 'success',
        data: response.data,
        url: response.config.url ?? null,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        return {
          status: 'error',
          message: error.message,
          url: error.config?.url || null,
        };
      }
      return {
        status: 'error',
        message: String(error),
        url: null,
      };
    }
  }
}

export default WolframAlphaClient;
