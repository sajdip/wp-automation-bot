const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

// Environment Variables
const BOT_SECRET_KEY = process.env.BOT_SECRET_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const WP_SITE_URL = process.env.WP_SITE_URL;

const SITE_LOGIN_URL = process.env.SITE_LOGIN_URL || 'https://mailpro.alwaysdata.net/index.php/service-portal/';
const SITE_USERNAME = process.env.SITE_USERNAME;
const SITE_PASSWORD = process.env.SITE_PASSWORD;

app.get('/', (req, res) => {
    res.send('MailPro Automation Bot is Running!');
});

app.post('/process-order', async (req, res) => {
    const { order_id, secret_key, input_name, input_digit, data_type, user_id } = req.body;

    if (secret_key !== BOT_SECRET_KEY) {
        return res.status(403).json({ success: false, message: 'Invalid Secret Key' });
    }

    res.status(200).json({ success: true, message: 'Processing started on MailPro Portal' });

    let browser;
    try {
        console.log(`Starting Automation for Order #${order_id}...`);
        
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--no-zygote',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(60000);

        // ১. লগইন প্রসেস
        await page.goto(SITE_LOGIN_URL, { waitUntil: 'networkidle2' });
        
        await page.waitForSelector('input[type="text"], input[type="email"], input[name="username"], input[name="user"]', { visible: true, timeout: 15000 });
        await page.type('input[type="text"], input[type="email"], input[name="username"], input[name="user"]', SITE_USERNAME);
        await page.type('input[type="password"]', SITE_PASSWORD);
        
        await Promise.all([
            page.keyboard.press('Enter'),
            page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
        ]);

        console.log('Login successful on MailPro Portal.');

        // ২. অর্ডার ফর্মে যাওয়া ও নিখুঁতভাবে ইনপুট প্রদান
        const orderPageUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=order_now&service_id=1';
        await page.goto(orderPageUrl, { waitUntil: 'networkidle2' });

        // ১. নাম ইনপুট
        if (input_name) {
            const nameInput = await page.$('input[type="text"]:not([type="hidden"])');
            if (nameInput) {
                await nameInput.click({ clickCount: 3 });
                await nameInput.type(input_name);
            }
        }

        // ২. ড্রপডাউন সিলেক্ট (প্রদত্ত তথ্যের ধরন)
        const selectElement = await page.$('select');
        if (selectElement) {
            const targetType = data_type || 'NID NUMBER';
            await page.evaluate((typeVal) => {
                const sel = document.querySelector('select');
                if (sel) {
                    for (let i = 0; i < sel.options.length; i++) {
                        if (sel.options[i].text.includes(typeVal) || sel.options[i].value.includes(typeVal)) {
                            sel.selectedIndex = i;
                            sel.dispatchEvent(new Event('change', { bubbles: true }));
                            break;
                        }
                    }
                }
            }, targetType);
        }

        // ৩. Digit/NID নম্বর ইনপুট
        if (input_digit) {
            const digitInput = await page.waitForSelector('input[name="digit"], input[type="number"]', { visible: true, timeout: 10000 });
            if (digitInput) {
                await digitInput.click({ clickCount: 3 });
                await digitInput.type(input_digit.toString());
            }
        }

        console.log('Inputs filled successfully. Submitting "Submit Order Now" button...');

        // ৪. Submit Order Now বাটনে ক্লিক ও ফর্ম সাবমিট
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
        ]);

        console.log('Order submitted successfully on third-party site!');

        // ৩. My Orders পেজে গিয়ে শুধুমাত্র নতুন অর্ডারের অনুমোদনের জন্য অপেক্ষা (সর্বোচ্চ ৭ মিনিট)
        const myOrdersUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=orders';
        await page.goto(myOrdersUrl, { waitUntil: 'networkidle2' });

        let fileDownloadUrl = null;
        const maxWaitTime = 7 * 60 * 1000;
        const checkInterval = 10 * 1000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            fileDownloadUrl = await page.evaluate(() => {
                // টেবিলের একদম প্রথম রো (অর্থাৎ শেষ জমা করা অর্ডারটি)
                const firstRow = document.querySelector('table tbody tr:first-child') || document.querySelector('table tr:nth-child(2)');
                if (firstRow) {
                    const rowText = firstRow.innerText.toUpperCase();
                    // যদি প্রথম রোর স্ট্যাটাস COMPLETED হয়
                    if (rowText.includes('COMPLETED')) {
                        const downloadBtn = firstRow.querySelector('a[href*="download"], a[href*="sop_action"]');
                        if (downloadBtn && downloadBtn.href) return downloadBtn.href;
                    }
                }
                return null;
            });

            if (fileDownloadUrl) {
                console.log('New order approved by Admin!');
                break;
            }

            console.log('Waiting for admin approval on top order...');
            await new Promise(r => setTimeout(r, checkInterval)); 
            await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
        }

        if (!fileDownloadUrl) {
            throw new Error('Order was submitted, but admin did not approve within 7 minutes.');
        }

        console.log(`File download URL found: ${fileDownloadUrl}`);

        // ৪. সেশন ধরে রেখে আসল ফাইল ডাউনলোড
        const downloadResponse = await page.goto(fileDownloadUrl, { waitUntil: 'networkidle2' });
        const fileBuffer = await downloadResponse.buffer();

        await browser.close();

        // GitHub-এ আপলোড
        const fileName = `order_${order_id}_${Date.now()}.pdf`;
        const githubUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/downloads/${fileName}`;
        
        const ghResponse = await axios.put(githubUrl, {
            message: `Auto Uploaded Order #${order_id}`,
            content: fileBuffer.toString('base64')
        }, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github+json'
            }
        });

        const rawDownloadUrl = ghResponse.data.content.download_url;

        // ৫. ওয়ার্ডপ্রেসে আপডেট পাঠানো
        if (WP_SITE_URL) {
            await axios.post(`${WP_SITE_URL}/wp-json/wp/v2/sop_orders`, {
                order_id: order_id,
                user_id: user_id,
                file_url: rawDownloadUrl,
                status: 'completed',
                secret_key: BOT_SECRET_KEY
            });
            console.log(`Order #${order_id} marked as completed in WordPress.`);
        }

    } catch (error) {
        if (browser) await browser.close();
        console.error(`Error processing Order #${order_id}:`, error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
