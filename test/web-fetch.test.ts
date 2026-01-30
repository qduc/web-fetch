import test from 'ava';
import {
    clearWebFetchCache,
    fetchWebPage,
} from '../src/index.js';

test.beforeEach(() => {
    clearWebFetchCache();
});

function createFetch(html: string, contentType = 'text/html') {
    return async (_input: any) => {
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: {
                get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
            },
            text: async () => html,
        };
    };
}

test('converts GitHub blob URLs to raw URLs', async (t) => {
    let calledUrl = '';
    const fetchImpl = async (input: any) => {
        calledUrl = String(input);
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: {
                get: () => 'text/plain',
            },
            text: async () => '<html><head><title>Doc</title></head><body><p>Hello</p></body></html>',
        };
    };

    await fetchWebPage({
        url: 'https://github.com/user/repo/blob/main/README.md',
        fetchImpl,
    });

    t.is(
        calledUrl,
        'https://raw.githubusercontent.com/user/repo/main/README.md',
    );
});

test('filters content by headings and returns a TOC', async (t) => {
    const html = `
        <html>
            <head><title>Example</title></head>
            <body>
                <main>
                    <h1>Section A</h1>
                    <p>Hello A</p>
                    <h1>Section B</h1>
                    <p>Hello B</p>
                </main>
            </body>
        </html>
    `;

    const result = await fetchWebPage({
        url: 'https://example.com',
        headings: ['Section A'],
        fetchImpl: createFetch(html),
    });

    t.truthy(result.toc);
    t.true(result.toc?.includes('Section A'));
    t.true(result.markdown.includes('Section A'));
    t.true(result.markdown.includes('Hello A'));
    t.false(result.markdown.includes('Hello B'));
});

test('supports continuation tokens for long content', async (t) => {
    const longText = 'Lorem ipsum '.repeat(200);
    const html = `
        <html>
            <head><title>Long Page</title></head>
            <body>
                <main>${longText}</main>
            </body>
        </html>
    `;

    const first = await fetchWebPage({
        url: 'https://example.com/long',
        maxChars: 120,
        fetchImpl: createFetch(html),
    });

    t.truthy(first.continuationToken);
    t.true(first.markdown.includes('[... Truncated ...]'));

    const next = await fetchWebPage({
        continuationToken: first.continuationToken!,
        maxChars: 120,
        fetchImpl: async () => {
            throw new Error('Fetch should not be called for continuations');
        },
    });

    t.true(next.markdown.length > 0);
});
