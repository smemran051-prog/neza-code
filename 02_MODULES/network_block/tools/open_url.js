'use strict';

const { shell } = require('electron');

module.exports = {
  name: 'open_url',
  description: 'Opens any website, URL, YouTube, or Google search in the default system browser.',
  tags: ['open', 'browser', 'youtube', 'google', 'url', 'website', 'edge', 'chrome'],
  risk: 'READ',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The full URL or domain name to open (e.g., https://youtube.com or google.com). REQUIRED.',
      },
    },
    required: ['url'],
  },
  async execute(args, ctx) {
    // FIX-3: No fallback. Hard error when url is missing.
    const rawUrl = typeof args?.url === 'string' ? args.url.trim() : '';
    if (!rawUrl) {
      throw new Error(
        'Error: URL parameter is required. Example: {"url": "https://youtube.com"}'
      );
    }

    let targetUrl = rawUrl;
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    // FIX-3: Strict protocol validation — no file://, javascript:, data:, etc.
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (_) {
      throw new Error(
        `Error: Invalid URL "${rawUrl}". Example: {"url": "https://youtube.com"}`
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `Error: Only http/https URLs are allowed. Got "${parsed.protocol}". Example: {"url": "https://youtube.com"}`
      );
    }

    try {
      await shell.openExternal(parsed.toString());
      return { success: true, message: `Successfully opened ${parsed.toString()} in the default browser.` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },
};