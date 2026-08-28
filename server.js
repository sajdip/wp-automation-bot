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

        // ১. লগইন পেজে যাওয়া ও লগইন
        await page.goto(SITE_LOGIN_URL, { waitUntil: 'networkidle2' });
        
        await page.waitForSelector('input[type="text"], input[type="email"], input[name="username"], input[name="user"]', { visible: true, timeout: 15000 });
        
        // ইউজারনেম ও পাসওয়ার্ড ইনপুট দেওয়া
        await page.type('input[type="text"], input[type="email"], input[name="username"], input[name="user"]', SITE_USERNAME);
        await page.type('input[type="password"]', SITE_PASSWORD);
        
        // বাটন সিলেক্টরের ওপর নির্ভর না করে ফর্ম সাবমিট ও Enter প্রেস করা
        await Promise.all([
            page.keyboard.press('Enter'),
            page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
        ]);

        console.log('Login successful on MailPro Portal.');

        // ২. অর্ডার ফর্মে যাওয়া ও তথ্য পূরণ
        const orderPageUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=order_now&service_id=1';
        await page.goto(orderPageUrl, { waitUntil: 'networkidle2' });

        // নাম পূরণ
        if (input_name) {
            const nameSelector = 'input[name="name"], input[placeholder*="নাম"], input[type="text"]';
            await page.waitForSelector(nameSelector, { visible: true, timeout: 10000 }).catch(() => {});
            const nameInput = await page.$(nameSelector);
            if (nameInput) await nameInput.type(input_name);
        }

        // Digit পূরণ
        if (input_digit) {
            const digitSelector = 'input[name="digit"], input[name="nid_number"], input[type="number"]';
            await page.waitForSelector(digitSelector, { visible: true, timeout: 10000 }).catch(() => {});
            const digitInput = await page.$(digitSelector);
            if (digitInput) {
                await digitInput.type(input_digit.toString());
                // ইনপুট দেওয়া শেষে Enter চাপবে যেন ফর্ম সাবমিট হয়
                await page.keyboard.press('Enter');
            }
        } else {
            // যদি digit না থাকে তবে সরাসরি JS দিয়ে ফর্ম সাবমিট করবে
            await page.evaluate(() => {
                const form = document.querySelector('form');
                if (form) form.submit();
            });
        }

        await new Promise(r => setTimeout(r, 4000)); // ৪ সেকেন্ড অপেক্ষা

        console.log('Order submitted. Navigating to My Orders history...');

        // ৩. My Orders পেজে গিয়ে ডাউনলোডের জন্য অপেক্ষা করা
        const myOrdersUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=orders';
        await page.goto(myOrdersUrl, { waitUntil: 'networkidle2' });

        let fileDownloadUrl = null;
        const startTime = Date.now();

        while (Date.now() - startTime < 40000) {
            fileDownloadUrl = await page.evaluate(() => {
                const rows = document.querySelectorAll('table tr');
                for (let row of rows) {
                    if (row.innerText.includes('COMPLETED')) {
                        const downloadBtn = row.querySelector('a');
                        if (downloadBtn) return downloadBtn.href;
                    }
                }
                return null;
            });

            if (fileDownloadUrl) break;
            await new Promise(r => setTimeout(r, 3000)); 
            await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
        }

        await browser.close();

        if (!fileDownloadUrl) {
            throw new Error('Completed download link not found in My Orders page within time limit');
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
