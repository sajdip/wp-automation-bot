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

        // ২. অর্ডার দেওয়ার আগের সর্বশেষ অর্ডারের রেফারেন্স নেওয়া (পুরোনো ডাটা এড়াতে)
        const myOrdersUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=orders';
        await page.goto(myOrdersUrl, { waitUntil: 'networkidle2' });
        
        const previousTopOrderReference = await page.evaluate(() => {
            const firstRow = document.querySelector('table tbody tr:first-child') || document.querySelector('table tr:nth-child(2)');
            return firstRow ? firstRow.innerText.trim() : '';
        });

        // ৩. অর্ডার ফর্মে যাওয়া ও ইনপুট পূরণ
        const orderPageUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=order_now&service_id=1';
        await page.goto(orderPageUrl, { waitUntil: 'networkidle2' });

        // নাম (অপশনাল) পূরণ
        if (input_name) {
            await page.evaluate((val) => {
                const el = document.querySelector('input[type="text"]:not([type="hidden"])');
                if (el) {
                    el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, input_name);
        }

        // ড্রপডাউন টাইপ সিলেক্ট
        if (data_type) {
            await page.evaluate((val) => {
                const sel = document.querySelector('select');
                if (sel) {
                    for (let opt of sel.options) {
                        if (opt.text.includes(val) || opt.value.includes(val)) {
                            sel.value = opt.value;
                            sel.dispatchEvent(new Event('change', { bubbles: true }));
                            break;
                        }
                    }
                }
            }, data_type);
        }

        // Digit/NID নম্বর পূরণ (বাধ্যতামূলক)
        if (input_digit) {
            await page.evaluate((val) => {
                const el = document.querySelector('input[name="digit"]') || document.querySelector('input[type="number"]');
                if (el) {
                    el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, input_digit.toString());
        }

        console.log('Inputs filled successfully. Submitting form directly...');

        // সরাসরি ফর্ম সাবমিট করা
        await page.evaluate(() => {
            const form = document.querySelector('form');
            if (form) form.submit();
        });

        await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
        console.log('Order form submission executed.');

        // ৪. নতুন অর্ডার তালিকায় এসেছে কিনা এবং অ্যাপ্রুভালের জন্য অপেক্ষা (সর্বোচ্চ ৭ মিনিট)
        await page.goto(myOrdersUrl, { waitUntil: 'networkidle2' });

        let fileDownloadUrl = null;
        const maxWaitTime = 7 * 60 * 1000;
        const checkInterval = 10 * 1000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const orderCheck = await page.evaluate((prevRef) => {
                const firstRow = document.querySelector('table tbody tr:first-child') || document.querySelector('table tr:nth-child(2)');
                if (!firstRow) return { isNew: false, completed: false, url: null };

                const currentText = firstRow.innerText.trim();
                const isNew = currentText !== prevRef; // নতুন অর্ডার কিনা তা যাচাই
                const statusText = currentText.toUpperCase();
                const isCompleted = statusText.includes('COMPLETED');
                const downloadBtn = firstRow.querySelector('a[href*="download"], a[href*="sop_action"]');

                return {
                    isNew: isNew,
                    completed: isCompleted,
                    url: downloadBtn ? downloadBtn.href : null
                };
            }, previousTopOrderReference);

            if (!orderCheck.isNew) {
                console.log('Order submission not registered on portal yet. Waiting...');
            } else if (orderCheck.completed && orderCheck.url) {
                fileDownloadUrl = orderCheck.url;
                console.log('New order successfully registered and approved by Admin!');
                break;
            } else {
                console.log('New order registered on portal. Waiting for admin approval...');
            }

            await new Promise(r => setTimeout(r, checkInterval)); 
            await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
        }

        if (!fileDownloadUrl) {
            throw new Error('Order submission failed or was not approved by admin within time limit.');
        }

        console.log(`File download URL found: ${fileDownloadUrl}`);

        // ৫. কুকি (Cookie) ব্যবহার করে নিরাপদে ফাইল ডাউনলোড করা (Frame Detached Error প্রতিরোধে)
        const cookies = await page.cookies();
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        
        await browser.close();

        const fileResponse = await axios.get(fileDownloadUrl, {
            headers: { 'Cookie': cookieHeader },
            responseType: 'arraybuffer'
        });
        const fileBuffer = Buffer.from(fileResponse.data);

        // ৬. GitHub-এ ফাইল আপলোড
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

        // ৭. ওয়ার্ডপ্রেসে আপডেট পাঠানো
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
