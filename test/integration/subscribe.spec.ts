import * as http from 'http';
import HttpProxyAgent = require('https-proxy-agent');
import * as zlib from 'zlib';

import {
    getLocal,
    getStandalone,
    getRemote,
    InitiatedRequest,
    CompletedRequest,
    CompletedResponse,
    Mockttp
} from "../..";
import { expect, fetch, nodeOnly, getDeferred, delay, isNode, sendRawRequest } from "../test-utils";
import { TimingEvents, TlsRequest } from "../../dist/types";

function makeAbortableRequest(server: Mockttp, path: string) {
    if (isNode) {
        let req = http.request({
            method: 'POST',
            hostname: 'localhost',
            port: server.port,
            path
        });
        req.on('error', () => {});
        return req;
    } else {
        let abortController = new AbortController();
        fetch(server.urlFor(path), {
            method: 'POST',
            signal: abortController.signal
        }).catch(() => {});
        return abortController;
    }
}

describe("Request initiated subscriptions", () => {
    describe("with a local server", () => {
        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should notify with request details as soon as they're ready", async () => {
            let seenRequestPromise = getDeferred<InitiatedRequest>();
            await server.on('request-initiated', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

            let seenRequest = await seenRequestPromise;
            expect(seenRequest.method).to.equal('POST');
            expect(seenRequest.httpVersion).to.equal('1.1');
            expect(seenRequest.url).to.equal(server.urlFor("/mocked-endpoint"));
            expect((seenRequest as any).body).to.equal(undefined); // No body included yet
        });

        nodeOnly(() => {
            it("should notify with request details before the body is received", async () => {
                let seenInitialRequestPromise = getDeferred<InitiatedRequest>();
                await server.on('request-initiated', (r) => seenInitialRequestPromise.resolve(r));
                let seenCompletedRequestPromise = getDeferred<CompletedRequest>();
                await server.on('request', (r) => seenCompletedRequestPromise.resolve(r));

                let req = http.request({
                    method: 'POST',
                    hostname: 'localhost',
                    port: server.port
                });

                req.write('start body\n');
                // Note: we haven't called .end() yet, the request is still going

                let seenInitialRequest = await seenInitialRequestPromise;
                expect(seenInitialRequest.method).to.equal('POST');
                expect(seenInitialRequest.httpVersion).to.equal('1.1');
                expect(seenInitialRequest.url).to.equal(server.urlFor('/'));
                expect((seenInitialRequest as any).body).to.equal(undefined);

                req.end('end body');
                let seenCompletedRequest = await seenCompletedRequestPromise;
                expect(seenCompletedRequest.body.text).to.equal('start body\nend body');
            });
        });
    });

    nodeOnly(() => {
        describe("with a remote client", () => {
            let standalone = getStandalone();
            let client = getRemote();

            before(() => standalone.start());
            after(() => standalone.stop());

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should notify with request details as soon as they're ready", async () => {
                let seenRequestPromise = getDeferred<InitiatedRequest>();
                await client.on('request-initiated', (r) => seenRequestPromise.resolve(r));

                fetch(client.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

                let seenRequest = await seenRequestPromise;
                expect(seenRequest.method).to.equal('POST');
                expect(seenRequest.httpVersion).to.equal('1.1');
                expect(seenRequest.url).to.equal(client.urlFor("/mocked-endpoint"));
                expect((seenRequest as any).body).to.equal(undefined); // No body included yet
            });
        });
    });
});

describe("Request subscriptions", () => {
    describe("with a local server", () => {
        let server = getLocal();

        beforeEach(() => server.start());
        afterEach(() => server.stop());

        it("should notify with request details & body when a request is ready", async () => {
            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

            let seenRequest = await seenRequestPromise;
            expect(seenRequest.method).to.equal('POST');
            expect(seenRequest.httpVersion).to.equal('1.1');
            expect(seenRequest.url).to.equal(server.urlFor("/mocked-endpoint"));
            expect(seenRequest.body.text).to.equal('body-text');
            expect(seenRequest.tags).to.deep.equal([]);
        });

        it("should include the matched rule id", async () => {
            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));
            let endpoint = await server.get('/').thenReply(200);

            fetch(server.urlFor("/"));

            let { matchedRuleId } = await seenRequestPromise;
            expect(matchedRuleId).to.equal(endpoint.id);
        });

        it("should include timing information", async () => {
            let seenRequestPromise = getDeferred<CompletedRequest>();
            await server.on('request', (r) => seenRequestPromise.resolve(r));

            fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

            let { timingEvents } = <{ timingEvents: TimingEvents }> await seenRequestPromise;
            expect(timingEvents.startTime).to.be.a('number');
            expect(timingEvents.startTimestamp).to.be.a('number');
            expect(timingEvents.bodyReceivedTimestamp).to.be.a('number');
            expect(timingEvents.startTime).not.to.equal(timingEvents.startTimestamp);

            expect(timingEvents.abortedTimestamp).to.equal(undefined);
        });

        nodeOnly(() => {
            it("should report unnormalized URLs", async () => {
                let seenRequestPromise = getDeferred<CompletedRequest>();
                await server.on('request', (r) => seenRequestPromise.resolve(r));

                sendRawRequest(server, 'GET http://example.com HTTP/1.1\n\n');

                let seenRequest = await seenRequestPromise;
                expect(seenRequest.url).to.equal('http://example.com');
            });
        });
    });

    nodeOnly(() => {
        describe("with a remote client", () => {
            let standalone = getStandalone();
            let client = getRemote();

            before(() => standalone.start());
            after(() => standalone.stop());

            beforeEach(() => client.start());
            afterEach(() => client.stop());

            it("should notify with request details after a request is made", async () => {
                let seenRequestPromise = getDeferred<CompletedRequest>();
                await client.on('request', (r) => seenRequestPromise.resolve(r));

                fetch(client.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

                let seenRequest = await seenRequestPromise;
                expect(seenRequest.method).to.equal('POST');
                expect(seenRequest.url).to.equal(
                    `http://localhost:${client.port}/mocked-endpoint`
                );
                expect(seenRequest.body.text).to.equal('body-text');
                expect(seenRequest.tags).to.deep.equal([]);
            });
        });
    });
});

describe("Response subscriptions", () => {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should notify with response details & body when a response is completed", async () => {
        server.get('/mocked-endpoint').thenReply(200, 'Mock response', {
            'x-extra-header': 'present'
        });

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        fetch(server.urlFor("/mocked-endpoint"));

        let seenResponse = await seenResponsePromise;
        expect(seenResponse.statusCode).to.equal(200);
        expect(seenResponse.headers['x-extra-header']).to.equal('present');
        expect(seenResponse.body.text).to.equal('Mock response');
        expect(seenResponse.tags).to.deep.equal([]);
    });

    it("should expose ungzipped bodies as .text", async () => {
        const body = zlib.gzipSync('Mock response');

        server.get('/mocked-endpoint').thenReply(200, body, {
            'content-encoding': 'gzip'
        });

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        fetch(server.urlFor("/mocked-endpoint"));

        let seenResponse = await seenResponsePromise;
        expect(seenResponse.statusCode).to.equal(200);
        expect(seenResponse.body.text).to.equal('Mock response');
    });

    it("should expose un-deflated bodies as .text", async () => {
        const body = zlib.deflateSync('Mock response');

        server.get('/mocked-endpoint').thenReply(200, body, {
            'content-encoding': 'deflate'
        });

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        fetch(server.urlFor("/mocked-endpoint"));

        let seenResponse = await seenResponsePromise;
        expect(seenResponse.statusCode).to.equal(200);
        expect(seenResponse.body.text).to.equal('Mock response');
    });

    it("should expose un-raw-deflated bodies as .text", async () => {
        const body = zlib.deflateRawSync('Mock response');

        server.get('/mocked-endpoint').thenReply(200, body, {
            'content-encoding': 'deflate'
        });

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        fetch(server.urlFor("/mocked-endpoint"));

        let seenResponse = await seenResponsePromise;
        expect(seenResponse.statusCode).to.equal(200);
        expect(seenResponse.body.text).to.equal('Mock response');
    });

    it("should include an id that matches the request event", async () => {
        server.get('/mocked-endpoint').thenReply(200);

        let seenRequestPromise = getDeferred<CompletedRequest>();
        let seenResponsePromise = getDeferred<CompletedResponse>();

        await Promise.all([
            server.on('request', (r) => seenRequestPromise.resolve(r)),
            server.on('response', (r) => seenResponsePromise.resolve(r))
        ]);

        fetch(server.urlFor("/mocked-endpoint"));

        let seenResponse = await seenResponsePromise;
        let seenRequest = await seenRequestPromise;

        expect(seenRequest.id).to.be.a('string');
        expect(seenRequest.id).to.equal(seenResponse.id);
    });

    it("should include timing information", async () => {
        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => seenResponsePromise.resolve(r));

        fetch(server.urlFor("/mocked-endpoint"), { method: 'POST', body: 'body-text' });

        let { timingEvents } = <{ timingEvents: TimingEvents }> await seenResponsePromise;
        expect(timingEvents.startTimestamp).to.be.a('number');
        expect(timingEvents.bodyReceivedTimestamp).to.be.a('number');
        expect(timingEvents.headersSentTimestamp).to.be.a('number');
        expect(timingEvents.responseSentTimestamp).to.be.a('number');

        expect(timingEvents.bodyReceivedTimestamp).to.be.greaterThan(timingEvents.startTimestamp);
        expect(timingEvents.headersSentTimestamp).to.be.greaterThan(timingEvents.startTimestamp);
        expect(timingEvents.responseSentTimestamp).to.be.greaterThan(timingEvents.headersSentTimestamp!);

        expect(timingEvents.abortedTimestamp).to.equal(undefined);
    });
});


describe("Abort subscriptions", () => {
    let server = getLocal();

    beforeEach(() => server.start());
    afterEach(() => server.stop());

    it("should not be sent for successful requests", async () => {
        let seenAbortPromise = getDeferred<InitiatedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));
        await server.get('/mocked-endpoint').thenReply(200);

        await fetch(server.urlFor("/mocked-endpoint"));

        await expect(Promise.race([
            seenAbortPromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');
    });

    it("should be sent when a request is aborted whilst handling", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<InitiatedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.post('/mocked-endpoint').thenCallback(() => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        let seenRequest = await seenRequestPromise;
        abortable.abort();

        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
        expect(seenRequest.tags).to.deep.equal([]);
    });

    it("should be sent when a request is aborted during an intentional timeout", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<InitiatedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.post('/mocked-endpoint').thenTimeout();

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        let seenRequest = await seenRequestPromise;
        abortable.abort();

        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
    });

    it("should be sent when a request is intentionally reset by a handler", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<InitiatedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.post('/mocked-endpoint').thenCloseConnection();

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        let seenRequest = await seenRequestPromise;
        abortable.abort();

        let seenAbort = await seenAbortPromise;
        expect(seenRequest.id).to.equal(seenAbort.id);
    });

    nodeOnly(() => {
        it("should be sent when a request is aborted before completion", async () => {
            let wasRequestSeen = false;
            await server.on('request', (r) => { wasRequestSeen = true; });

            let seenAbortPromise = getDeferred<InitiatedRequest>();
            await server.on('abort', (r) => seenAbortPromise.resolve(r));

            let abortable = makeAbortableRequest(server, '/mocked-endpoint') as http.ClientRequest;
            // Start writing a body, but never .end(), so it never completes
            abortable.write('start request', () => abortable.abort());

            let seenAbort = await seenAbortPromise;
            expect(seenAbort.timingEvents.bodyReceivedTimestamp).to.equal(undefined);
            expect(wasRequestSeen).to.equal(false);
        });
    });

    it("should be sent in place of response notifications, not in addition", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenResponsePromise = getDeferred<CompletedResponse>();
        await server.on('response', (r) => Promise.resolve(r));

        await server.post('/mocked-endpoint').thenCallback((req) => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        await seenRequestPromise;
        abortable.abort();

        await expect(Promise.race([
            seenResponsePromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');
    });

    it("should include timing information", async () => {
        let seenRequestPromise = getDeferred<CompletedRequest>();
        await server.on('request', (r) => seenRequestPromise.resolve(r));

        let seenAbortPromise = getDeferred<InitiatedRequest>();
        await server.on('abort', (r) => seenAbortPromise.resolve(r));

        await server.post('/mocked-endpoint').thenCallback(() => delay(500).then(() => ({})));

        let abortable = makeAbortableRequest(server, '/mocked-endpoint');
        nodeOnly(() => (abortable as http.ClientRequest).end('request body'));

        await seenRequestPromise;
        abortable.abort();

        let { timingEvents } = <{ timingEvents: TimingEvents }> await seenAbortPromise;
        expect(timingEvents.startTimestamp).to.be.a('number');
        expect(timingEvents.bodyReceivedTimestamp).to.be.a('number');
        expect(timingEvents.abortedTimestamp).to.be.a('number');

        expect(timingEvents.abortedTimestamp).to.be.greaterThan(timingEvents.startTimestamp);

        expect(timingEvents.headersSentTimestamp).to.equal(undefined);
        expect(timingEvents.responseSentTimestamp).to.equal(undefined);
    });
});

describe("TLS error subscriptions", () => {
    let goodServer = getLocal({
        https: {
            keyPath: './test/fixtures/test-ca.key',
            certPath: './test/fixtures/test-ca.pem'
        }
    });

    let badServer = getLocal({
        https: {
            keyPath: './test/fixtures/untrusted-ca.key',
            certPath: './test/fixtures/untrusted-ca.pem'
        }
    });

    beforeEach(async () => {
        await badServer.start();
        await goodServer.start();
    });

    afterEach(() => Promise.all([
        badServer.stop(),
        goodServer.stop()
    ]));

    it("should not be sent for successful requests", async () => {
        let seenTlsErrorPromise = getDeferred<TlsRequest>();
        await goodServer.on('tlsClientError', (r) => seenTlsErrorPromise.resolve(r));

        await fetch(goodServer.urlFor("/").replace('http:', 'https:'));

        await expect(Promise.race([
            seenTlsErrorPromise,
            delay(100).then(() => { throw new Error('timeout') })
        ])).to.be.rejectedWith('timeout');
    });

    it("should be sent for requests from clients that reject the certificate initially", async () => {
        let seenTlsErrorPromise = getDeferred<TlsRequest>();
        await badServer.on('tlsClientError', (r) => seenTlsErrorPromise.resolve(r));

        await expect(
            fetch(badServer.urlFor("/"))
        ).to.be.rejectedWith(
            // Broken by bad TS handling of overrides, see https://github.com/DefinitelyTyped/DefinitelyTyped/pull/37292
            (isNode ? /certificate/ : 'Failed to fetch') as any
        );

        const tlsError = await seenTlsErrorPromise;

        expect(tlsError.failureCause).to.be.oneOf([
            // Depends on specific client behaviour:
            'reset', // Node 12
            'closed', // Node 10
            'cert-rejected' // Chrome
        ]);
        expect(tlsError.hostname).to.equal('localhost');
        expect(tlsError.remoteIpAddress).to.be.oneOf([
            '::ffff:127.0.0.1', // IPv4 localhost
            '::1' // IPv6 localhost
        ]);
        expect(tlsError.tags).to.deep.equal([]);
    });

    nodeOnly(() => {
        it("should be sent for requests from clients that reject the certificate for the upstream server", async () => {
            let seenTlsErrorPromise = getDeferred<TlsRequest>();
            await badServer.on('tlsClientError', (r) => seenTlsErrorPromise.resolve(r));
            await badServer.anyRequest().thenPassThrough();

            await expect(
                fetch(goodServer.urlFor("/"), <any> {
                    // Ignores proxy cert issues by using the proxy via plain HTTP
                    agent: new HttpProxyAgent({
                        host: 'localhost',
                        port: badServer.port
                    })
                })
            ).to.be.rejectedWith(/certificate/);

            const tlsError = await seenTlsErrorPromise;
            expect(tlsError.failureCause).to.equal('closed');
            expect(tlsError.hostname).to.equal('localhost');
            expect(tlsError.remoteIpAddress).to.equal('::ffff:127.0.0.1');
        });
    });
});