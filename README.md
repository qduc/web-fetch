# @qduc/web-fetch

Fetch web pages and convert HTML to Markdown with readability extraction, heading filtering, and continuation tokens.

## Install

```bash
npm install @qduc/web-fetch
```

## Usage

```ts
import { fetchWebPage } from '@qduc/web-fetch';

const result = await fetchWebPage({
  url: 'https://example.com',
  maxChars: 8000,
});

console.log(result.title);
console.log(result.toc);
console.log(result.markdown);
```

## API

### `fetchWebPage(options)`

- `options.url` - URL to fetch (required unless `continuationToken` is provided)
- `options.maxChars` - maximum characters per response (default: 10000)
- `options.headings` - array of heading strings or indices to filter content
- `options.continuationToken` - token returned from previous response
- `options.timeoutMs` - fetch timeout in milliseconds (default: 15000)
- `options.userAgent` - custom User-Agent header
- `options.maxBodySizeBytes` - max response size (default: 10MB)
- `options.fetchImpl` - custom fetch implementation (useful for tests)

### `clearWebFetchCache()`

Clears the in-memory continuation cache.
