import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

const DEFAULT_MAX_CHARS = 10000;
const MAX_CHARS_LIMIT = 200000;
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;
const MIN_READABILITY_LENGTH = 300;
const MIN_SELECTOR_LENGTH = 300;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (compatible; WebFetch/1.0; +https://github.com/qduc/term2)';

export type FetchLikeResponse = {
    ok: boolean;
    status: number;
    statusText: string;
    headers: {
        get(name: string): string | null;
    };
    text(): Promise<string>;
};

export type FetchLike = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<FetchLikeResponse>;

export type WebFetchOptions = {
    url?: string;
    maxChars?: number;
    headings?: Array<string | number>;
    continuationToken?: string;
    timeoutMs?: number;
    userAgent?: string;
    maxBodySizeBytes?: number;
    fetchImpl?: FetchLike;
};

export type WebFetchResult = {
    title: string;
    url: string;
    markdown: string;
    toc: string | null;
    continuationToken: string | null;
    method: string;
};

const contentCache = new Map<
    string,
    {
        markdown: string;
        offset: number;
        url: string;
        title: string;
        metadata: { method: string };
        timestamp: number;
    }
>();
const CACHE_TTL = 5 * 60 * 1000;

const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of contentCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            contentCache.delete(key);
        }
    }
}, 60 * 1000);

cleanupInterval.unref();

export function clearWebFetchCache() {
    contentCache.clear();
}

function generateCacheKey(url: string, type: string, value: unknown): string {
    return `${url}:${type}:${JSON.stringify(value)}:${Date.now()}`;
}

function convertGithubToRaw(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.hostname === 'github.com') {
            const parts = parsed.pathname.split('/').filter(Boolean);
            if (parts.length >= 4 && parts[2] === 'blob') {
                const user = parts[0];
                const repo = parts[1];
                const branch = parts[3];
                const filePath = parts.slice(4).join('/');
                return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${filePath}`;
            }
        }
    } catch {
        return url;
    }
    return url;
}

function cleanHtml(html: string): string {
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
}

function extractHeadings(html: string) {
    const headingRegex = /<h([1-3])[^>]*>(.*?)<\/h\1>/gi;
    const headings: Array<{ level: number; text: string; position: number }> = [];
    let match;
    while ((match = headingRegex.exec(html)) !== null) {
        const text = match[2].replace(/<[^>]*>/g, '').trim();
        if (text) {
            headings.push({
                level: Number.parseInt(match[1], 10),
                text,
                position: match.index,
            });
        }
    }
    return headings;
}

function buildTOC(headings: Array<{ level: number; text: string }>) {
    if (headings.length === 0) return null;
    return headings
        .map((heading) => `${'  '.repeat(heading.level - 1)}- ${heading.text}`)
        .join('\n');
}

function filterContentByHeadings(
    html: string,
    headings: Array<{ level: number; text: string; position: number }>,
    targets: Array<string | number>,
) {
    let combinedHtml = '';
    let filtered = false;

    for (const target of targets) {
        let index = -1;
        if (typeof target === 'number') {
            index = target - 1;
        } else {
            const lower = target.toLowerCase();
            index = headings.findIndex((heading) =>
                heading.text.toLowerCase().includes(lower),
            );
        }

        if (index >= 0 && index < headings.length) {
            filtered = true;
            const start = headings[index].position;
            let end = html.length;
            for (let i = index + 1; i < headings.length; i += 1) {
                if (headings[i].level <= headings[index].level) {
                    end = headings[i].position;
                    break;
                }
            }
            combinedHtml += `${html.substring(start, end)}\n\n`;
        }
    }

    return {
        html: combinedHtml,
        filtered,
        error: filtered ? null : 'No matching headings found',
    };
}

function truncateMarkdown(markdown: string, maxChars: number, offset: number) {
    const start = offset;
    if (start >= markdown.length) {
        return { markdown: '', hasMore: false, nextOffset: start };
    }

    if (markdown.length - start <= maxChars) {
        return {
            markdown: markdown.substring(start),
            hasMore: false,
            nextOffset: markdown.length,
        };
    }

    let end = start + maxChars;
    const lastNewline = markdown.lastIndexOf('\n', end);
    if (lastNewline > start + maxChars * 0.8) {
        end = lastNewline;
    }

    return {
        markdown:
            `${markdown.substring(start, end).trim()}\n\n[... Truncated ...]`,
        hasMore: true,
        nextOffset: end,
        originalLength: markdown.length,
    };
}

function handleContinuation(token: string, maxChars: number) {
    const cached = contentCache.get(token);
    if (!cached) {
        throw new Error('Continuation token expired or invalid.');
    }

    const result = truncateMarkdown(cached.markdown, maxChars, cached.offset);
    let nextToken: string | null = null;
    if (result.hasMore) {
        nextToken = generateCacheKey(cached.url, 'continuation', result.nextOffset);
        contentCache.set(nextToken, {
            ...cached,
            offset: result.nextOffset,
            timestamp: Date.now(),
        });
    }

    return {
        title: cached.title,
        url: cached.url,
        toc: null,
        markdown: result.markdown,
        continuationToken: nextToken,
        method: cached.metadata.method,
    } satisfies WebFetchResult;
}

export async function fetchWebPage(
    options: WebFetchOptions,
): Promise<WebFetchResult> {
    const {
        url,
        maxChars = DEFAULT_MAX_CHARS,
        headings,
        continuationToken,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        userAgent = DEFAULT_USER_AGENT,
        maxBodySizeBytes = DEFAULT_MAX_BODY_SIZE,
        fetchImpl = globalThis.fetch,
    } = options;

    if (continuationToken) {
        return handleContinuation(continuationToken, maxChars);
    }

    if (!url) {
        throw new Error('URL is required for initial fetch.');
    }

    if (!fetchImpl) {
        throw new Error('Fetch implementation is not available.');
    }

    if (maxChars < 200 || maxChars > MAX_CHARS_LIMIT) {
        throw new Error(`maxChars must be between 200 and ${MAX_CHARS_LIMIT}.`);
    }

    const effectiveUrl = convertGithubToRaw(url);
    const response = await fetchImpl(effectiveUrl, {
        headers: {
            'User-Agent': userAgent,
        },
        signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
        throw new Error(
            `HTTP error! status: ${response.status} ${response.statusText}`,
        );
    }

    const contentType = response.headers.get('content-type') || '';
    if (
        !contentType.includes('text/html') &&
        !contentType.includes('application/xhtml+xml') &&
        !contentType.includes('text/plain')
    ) {
        if (
            !contentType.includes('text') &&
            !contentType.includes('json') &&
            !contentType.includes('xml')
        ) {
            throw new Error(`Unsupported content type: ${contentType}`);
        }
    }

    const html = await response.text();
    if (html.length > maxBodySizeBytes) {
        throw new Error(
            `Response body exceeds maximum size limit of ${maxBodySizeBytes / (1024 * 1024)} MB`,
        );
    }

    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    let extractedContent: { html: string; title: string; excerpt?: string } | null =
        null;
    let method = 'unknown';

    try {
        const reader = new Readability(doc.cloneNode(true) as any);
        const article = reader.parse();
        if (article && (article.length || 0) > MIN_READABILITY_LENGTH) {
                extractedContent = {
                    html: article.content ?? '',
                    title: article.title ?? (doc.title || 'Untitled'),
                    excerpt: article.excerpt ?? undefined,
                };
            method = 'readability';
        }
    } catch {
        extractedContent = null;
    }

    if (!extractedContent) {
        const selectors = ['main', 'article', '#content', '.content', '.main'];
        for (const selector of selectors) {
            const element = doc.querySelector(selector);
            if (element && (element.textContent?.trim().length || 0) > MIN_SELECTOR_LENGTH) {
                extractedContent = {
                    html: element.innerHTML,
                    title: doc.title || 'Untitled',
                };
                method = `selector:${selector}`;
                break;
            }
        }
    }

    if (!extractedContent) {
        extractedContent = {
            html: cleanHtml(html),
            title: doc.title || 'Untitled',
        };
        method = 'basic-clean';
    }

    const allHeadings = extractHeadings(extractedContent.html);
    const toc = buildTOC(allHeadings);

    let filteredHtml = extractedContent.html;
    if (headings && headings.length > 0) {
        const filterResult = filterContentByHeadings(
            extractedContent.html,
            allHeadings,
            headings,
        );
        if (!filterResult.error && filterResult.filtered) {
            filteredHtml = filterResult.html;
        }
    }

    const turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
    });

    let markdown = turndownService.turndown(filteredHtml);
    const truncationResult = truncateMarkdown(markdown, maxChars, 0);
    markdown = truncationResult.markdown;

    let nextContinuationToken: string | null = null;
    if (truncationResult.hasMore && allHeadings.length === 0) {
        nextContinuationToken = generateCacheKey(
            url,
            'continuation',
            truncationResult.nextOffset,
        );
        contentCache.set(nextContinuationToken, {
            markdown: turndownService.turndown(extractedContent.html),
            offset: truncationResult.nextOffset,
            url,
            title: extractedContent.title,
            metadata: { method },
            timestamp: Date.now(),
        });
    }

    return {
        title: extractedContent.title,
        url,
        markdown,
        toc,
        continuationToken: nextContinuationToken,
        method,
    } satisfies WebFetchResult;
}
