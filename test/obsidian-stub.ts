import { vi } from 'vitest';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';

/** Tests exercise the real Drive client with only the Obsidian transport replaced. */
export const requestUrl = vi.fn<(params: RequestUrlParam) => Promise<RequestUrlResponse>>();
