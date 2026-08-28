const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');
const app = express();

app.use(express.json());

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
    const payload = req.body;
    console.log("📥 Data received from WordPress:", payload);

    const order_id = payload.order_id;
    const secret_key = payload.secret_key;
    const user_id = payload.user_id;

    // ডিফল্ট ভ্যালু
    let input_name = payload.input_name || '';
    let input_digit = payload.input_digit || '';
    let data_type = payload.data_type || 'NID NUMBER';

    // স্মার্ট ডেটা এক্সট্রাকশন (যাতে স্পেস বা বানানের জন্য মিস না হয়)
    if (payload.input_data) {
        const keys = Object.keys(payload.input_data);
        
        const nameKey = keys.find(k => k.includes('নাম') || k.includes('Name') || k.includes('name'));
        if (nameKey) input_name = payload.input_data[nameKey];

        const digitKey = keys.find(k => k.toLowerCase().includes('digit') || k.includes('ডিজিট'));
        if (digitKey) input_digit = payload.input_data[digitKey];

        const typeKey = keys.find(k => k.includes('ধরন') || k.includes('type'));
        if (typeKey) data_type = payload.input_data[typeKey];
    }

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
        await page.setViewport({ width: 1440, height: 900 });
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

        // ২. পোর্টালে থাকা সর্বোচ্চ (Maximum) অর্ডার আইডি বের করা
        const myOrdersUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=orders';
        await page.goto(myOrdersUrl, { waitUntil: 'networkidle2' });
        await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        
        const previousMaxOrderId = await page.evaluate(() => {
            let maxId = 0;
            const rows = document.querySelectorAll('table tbody tr, table tr');
            rows.forEach(row => {
                const match = row.innerText.match(/#(\d+)/);
                if (match) {
                    const id = parseInt(match[1], 10);
                    if (id > maxId) maxId = id;
                }
            });
            return maxId;
        });

        console.log(`Previous Top Order ID on portal: #${previousMaxOrderId}`);

        // ৩. নতুন অর্ডার সাবমিট করা
        const orderPageUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=order_now&service_id=1';
        await page.goto(orderPageUrl, { waitUntil: 'networkidle2' });

        await new Promise(r => setTimeout(r, 2000));

        // স্মার্ট ইনপুট ফিলিং (সিরিয়াল অনুযায়ী)
        const textInputs = await page.$$('input[type="text"]:not([type="hidden"]), input[type="number"]:not([type="hidden"])');
        
        if (textInputs.length >= 2) {
            // প্রথম ফিল্ডে নাম বসবে
            if (input_name) {
                await textInputs[0].click({ clickCount: 3 });
                await textInputs[0].type(input_name.toString(), { delay: 50 }); 
            }
            // দ্বিতীয় ফিল্ডে ডিজিট বসবে
            if (input_digit) {
                await textInputs[1].click({ clickCount: 3 });
                await textInputs[1].type(input_digit.toString(), { delay: 50 });
            }
        }

        // ড্রপডাউন সিলেক্ট
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
        }, data_type);

        console.log(`Inputs filled: Name=${input_name}, Digit=${input_digit}, Type=${data_type}. Submitting form...`);
        await new Promise(r => setTimeout(r, 1000));

        // সবচেয়ে নিরাপদ ক্লিক মেথড
        const submitBtnSelector = 'button[type="submit"], input[type="submit"], #sop_order_submit_btn';
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log('Navigation timeout after submit...')),
            page.evaluate((sel) => {
                const btn = document.querySelector(sel);
                if(btn) btn.click();
            }, submitBtnSelector)
        ]);

        console.log('Order submit action performed and redirected to history page.');

        // ৪. নতুন অর্ডার এবং ডাউনলোডের জন্য অপেক্ষা
        let fileDownloadUrl = null;
        const maxWaitTime = 7 * 60 * 1000; 
        const checkInterval = 10 * 1000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));

            let orderCheck = { isNew: false, completed: false, url: null };
            
            try {
                orderCheck = await page.evaluate((prevMaxId) => {
                    const rows = Array.from(document.querySelectorAll('table tbody tr, table tr'));
                    for (const row of rows) {
                        const text = row.innerText;
                        const match = text.match(/#(\d+)/);
                        if (match) {
                            const currentId = parseInt(match[1], 10);
                            if (currentId > prevMaxId) {
                                const downloadBtn = row.querySelector('a.sop-link-btn, a[href*="sop_action=download"], a[href*="download"]');
                                return {
                                    isNew: true,
                                    completed: downloadBtn !== null || text.toUpperCase().includes('COMPLETED'),
                                    url: downloadBtn ? downloadBtn.href : null
                                };
                            }
                        }
                    }
                    return { isNew: false, completed: false, url: null };
                }, previousMaxOrderId);
            } catch (evalError) {
                console.log('Waiting for table render...');
            }

            if (!orderCheck.isNew) {
                console.log('Order submission not registered on portal yet. Waiting...');
            } else if (orderCheck.completed && orderCheck.url) {
                fileDownloadUrl = orderCheck.url;
                console.log(`New order approved! Download Link Found: ${fileDownloadUrl}`);
                break;
            } else {
                console.log('New order registered on portal. Waiting for COMPLETED status and Download Link...');
            }

            await new Promise(r => setTimeout(r, checkInterval)); 
            await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
        }

        if (!fileDownloadUrl) {
            throw new Error('Order submission failed or was not approved by admin within time limit.');
        }

        // ৫. কুকি সেসন সহ ফাইল ডাউনলোড
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

        // ৭. ওয়ার্ডপ্রেসে স্ট্যাটাস আপডেট
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
