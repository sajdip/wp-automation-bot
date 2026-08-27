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
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        // ১. লগইন পেজে যাওয়া ও লগইন
        await page.goto(SITE_LOGIN_URL, { waitUntil: 'networkidle2' });
        
        // লগইন ইনপুট ফিল্ড ও পাসওয়ার্ড ফিল্ড
        await page.type('input[type="text"], input[type="email"]', SITE_USERNAME);
        await page.type('input[type="password"]', SITE_PASSWORD);
        
        await Promise.all([
            page.click('button[type="submit"], input[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);

        console.log('Login successful on MailPro Portal.');

        // ২. অর্ডার ফর্মে যাওয়া ও তথ্য পূরণ
        const orderPageUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=order_now&service_id=1';
        await page.goto(orderPageUrl, { waitUntil: 'networkidle2' });

        // নাম (অপশনাল) পূরণ
        if (input_name) {
            const nameInput = await page.$('input[name="name"], input[placeholder*="নাম"]');
            if (nameInput) await nameInput.type(input_name);
        }

        // Digit পূরণ
        if (input_digit) {
            const digitInput = await page.$('input[name="digit"], input[name="nid_number"]');
            if (digitInput) await digitInput.type(input_digit.toString());
        }

        // Submit Order Now বাটনে ক্লিক
        await Promise.all([
            page.click('button[type="submit"], input[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
        ]);

        console.log('Order submitted. Navigating to My Orders history...');

        // ৩. My Orders পেজে গিয়ে ডাউনলোডের জন্য ওয়েট করা
        const myOrdersUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=orders';
        await page.goto(myOrdersUrl, { waitUntil: 'networkidle2' });

        // স্ট্যাটাস COMPLETED হওয়া এবং Download বাটন পাওয়া পর্যন্ত সর্বোচ্চ ৩০ সেকেন্ড ওয়েট
        await page.waitForSelector('a.btn, button:contains("Download"), td:contains("COMPLETED")', { timeout: 30000 }).catch(() => {});

        // ডাউনলোডের ইউআরএল (Download Link) সংগ্রহ
        const fileDownloadUrl = await page.evaluate(() => {
            const rows = document.querySelectorAll('table tr');
            for (let row of rows) {
                if (row.innerText.includes('COMPLETED')) {
                    const downloadBtn = row.querySelector('a');
                    if (downloadBtn) return downloadBtn.href;
                }
            }
            return null;
        });

        await browser.close();

        if (!fileDownloadUrl) {
            throw new Error('Completed download link not found in My Orders page');
        }

        console.log(`File download URL found: ${fileDownloadUrl}`);

        // ৪. ফাইল ডাউনলোড করে GitHub-এ আপলোড
        const fileResponse = await axios.get(fileDownloadUrl, { responseType: 'arraybuffer' });
        const fileBuffer = Buffer.from(fileResponse.data);
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
        }

    } catch (error) {
        if (browser) await browser.close();
        console.error(`Error processing Order #${order_id}:`, error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
