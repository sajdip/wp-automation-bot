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

const SITE_LOGIN_URL = process.env.SITE_LOGIN_URL;
const SITE_USERNAME = process.env.SITE_USERNAME;
const SITE_PASSWORD = process.env.SITE_PASSWORD;

app.get('/', (req, res) => {
    res.send('Puppeteer Web Automation Bot is Active!');
});

app.post('/process-order', async (req, res) => {
    const { order_id, secret_key, input_data, user_id } = req.body;

    if (secret_key !== BOT_SECRET_KEY) {
        return res.status(403).json({ success: false, message: 'Invalid Secret Key' });
    }

    res.status(200).json({ success: true, message: 'Browser Automation Started' });

    let browser;
    try {
        console.log(`Starting Browser for Order #${order_id}...`);
        
        // ১. হেডলেস ব্রাউজার চালু করা
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        // ২. লগইন পেজে যাওয়া এবং লগইন করা
        await page.goto(SITE_LOGIN_URL, { waitUntil: 'networkidle2' });

        // *নোট: নিচের ফিল্ড নেমগুলো আপনার থার্ডপার্টি সাইটের input field অনুযায়ী পরিবর্তন করতে হতে পারে*
        await page.type('input[type="text"], input[type="email"], input[name="username"]', SITE_USERNAME);
        await page.type('input[type="password"]', SITE_PASSWORD);
        
        await Promise.all([
            page.click('button[type="submit"], input[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);

        console.log('Login Successful!');

        // ৩. ফর্মে ডেটা সাবমিট করা
        // উদাহরণ: ইউজার থেকে পাওয়া তথ্য ফর্মে পূরণ করা
        if (input_data) {
            await page.type('#order_input_field', input_data); // আপনার সাইটের ফর্ম ফিল্ড আইডি/নেম
            await page.click('#submit_order_button'); // ফর্ম সাবমিট বাটন
            await page.waitForTimeout(3000); 
        }

        // ৪. জেনারেট হওয়া ফাইল বা পেজ বাফার হিসেবে নেওয়া
        // (এখানে ফাইল ডাউনলোড লিংক বা পেজটিকে PDF হিসেবে গিটহাবে পাঠানো হচ্ছে)
        const fileBuffer = await page.pdf({ format: 'A4' }); 
        const fileName = `order_${order_id}_${Date.now()}.pdf`;

        await browser.close();

        // ৫. GitHub Storage-এ আপলোড
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
        console.log(`Uploaded to GitHub: ${rawDownloadUrl}`);

        // ৬. ওয়ার্ডপ্রেসে স্ট্যাটাস ব্যাক পাঠানো
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
