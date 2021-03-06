/* global $, window */
const Apify = require('apify');
const cheerio = require('cheerio');
const createSearchUrls = require('./createSearchUrls');
const parseSellerDetail = require('./parseSellerDetail');
const { parseItemUrls } = require('./parseItemUrls');
const parsePaginationUrl = require('./parsePaginationUrl');
const { saveItem, getOriginUrl } = require('./utils');
const detailParser = require('./parseItemDetail');
const CloudFlareUnBlocker = require('./unblocker');

const { log } = Apify.utils;
// TODO: Add an option to limit number of results for each keyword
Apify.main(async () => {
    // Get queue and enqueue first url.
    const requestQueue = await Apify.openRequestQueue();
    const input = await Apify.getValue('INPUT');
    const env = await Apify.getEnv();
    // based on the input country and keywords, generate the search urls
    const urls = await createSearchUrls(input);
    for (const searchUrl of urls) {
        console.log(searchUrl.url);
        await requestQueue.addRequest(searchUrl);
    }

    const proxyConfiguration = { ...input.proxy };
    const cloudFlareUnBlocker = new CloudFlareUnBlocker({
        proxyConfiguration,
    });

    // Create crawler.
    const crawler = new Apify.BasicCrawler({
        requestQueue,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 30,
            persistStateKeyValueStoreId: 'amazon-sessions',
            sessionOptions: {
                maxUsageCount: 50,
            },
        },
        maxConcurrency: input.maxConcurrency || 5,
        maxRequestsPerCrawl: input.maxRequestsPerCrawl || null,
        handlePageTimeoutSecs: 2.5 * 60,
        persistCookiesPerSession: true,
        handleRequestFunction: async ({ request, session }) => {
            const responseRequest = await cloudFlareUnBlocker.unblock({ request, session });
            const $ = cheerio.load(responseRequest.body);
            // to handle blocked requests
            const title = $('title').length !== 0 ? $('title').text().trim() : '';
            const { statusCode } = responseRequest;
            if (statusCode !== 200
                || title.includes('Robot Check')
                || title.includes('CAPTCHA')
                || title.includes('Toutes nos excuses')
                || title.includes('Tut uns Leid!')
                || title.includes('Service Unavailable Error')) {
                session.retire();
                // dont mark this request as bad, it is probably looking for working session
                request.retryCount--;
                // dont retry the request right away, wait a little bit
                await Apify.utils.sleep(5000);
                throw new Error('Session blocked, retiring. If you see this for a LONG time, stop the run - you don\'t have any working proxy right now.'
                    + ' But by default this can happen for some time until we find working session.');
            }

            const urlOrigin = await getOriginUrl(request);
            // add pagination and items on the search
            if (request.userData.label === 'page') {
                // solve pagination if on the page, now support two layouts
                const enqueuePagination = await parsePaginationUrl($, request);
                if (enqueuePagination !== false) {
                    log.info(`Adding new pagination of search ${enqueuePagination}`);
                    await requestQueue.addRequest({
                        url: enqueuePagination,
                        userData: {
                            label: 'page',
                            keyword: request.userData.keyword,
                        },
                    });
                }
                // add items to the queue
                try {
                    const items = await parseItemUrls($, request);
                    for (const item of items) {
                        await requestQueue.addRequest({
                            url: item.url,
                            userData: {
                                label: 'detail',
                                keyword: request.userData.keyword,
                                asin: item.asin,
                                detailUrl: item.detailUrl,
                                sellerUrl: item.sellerUrl,
                            },
                        }, { forefront: true });
                    }

                    if (items.length === 0) {
                        await Apify.pushData({
                            status: 'No items for this keyword.',
                            url: request.url,
                            keyword: request.userData.keyword,
                        });
                    }
                } catch (error) {
                    await Apify.pushData({
                        status: 'No items for this keyword.',
                        url: request.url,
                        keyword: request.userData.keyword,
                    });
                }
                // extract info about item and about seller offers
            } else if (request.userData.label === 'detail') {
                try {
                    await detailParser($, request, requestQueue);
                } catch (e) {
                    log.error('Detail parsing failed', e);
                }
            } else if (request.userData.label === 'seller') {
                try {
                    const item = await parseSellerDetail($, request);
                    if (item) {
                        let paginationUrlSeller;
                        const paginationEle = $('ul.a-pagination li.a-last a');
                        if (paginationEle.length !== 0) {
                            paginationUrlSeller = urlOrigin + paginationEle.attr('href');
                        } else {
                            paginationUrlSeller = false;
                        }

                        // if there is a pagination, go to another page
                        if (paginationUrlSeller !== false) {
                            log.info(`Seller detail has pagination, crawling that now -> ${paginationUrlSeller}`);
                            await requestQueue.addRequest({
                                url: paginationUrlSeller,
                                userData: {
                                    label: 'seller',
                                    itemDetail: request.userData.itemDetail,
                                    keyword: request.userData.keyword,
                                    asin: request.userData.asin,
                                    detailUrl: request.userData.detailUrl,
                                    sellerUrl: request.userData.sellerUrl,
                                    sellers: item.sellers,
                                },
                            }, { forefront: true });
                        } else {
                            log.info(`Saving item url: ${request.url}`);
                            await saveItem('RESULT', request, item, input, env.defaultDatasetId, session);
                        }
                    }
                } catch (error) {
                    console.error(error);
                    await saveItem('NORESULT', request, null, input, env.defaultDatasetId);
                }
            }
        },

        // If request failed 4 times then this function is executed.
        handleFailedRequestFunction: async ({ request }) => {
            log.info(`Request ${request.url} failed 4 times`);
            await Apify.setValue(`bug_${Math.random()}.html`, $('body').html(), { contentType: 'text/html' });
        },
    });

    // Run crawler.
    await crawler.run();
});
