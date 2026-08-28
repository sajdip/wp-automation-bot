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

        // ২. পুরোনো শেষ অর্ডারের রেফারেন্স সংরক্ষণ
        const myOrdersUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=orders';
        await page.goto(myOrdersUrl, { waitUntil: 'networkidle2' });
        
        const previousTopOrderReference = await page.evaluate(() => {
            const firstRow = document.querySelector('table tbody tr:first-child') || document.querySelector('table tr:nth-child(2)');
            return firstRow ? firstRow.innerText.trim() : '';
        });

        // ৩. অর্ডার ফর্মে যাওয়া
        const orderPageUrl = 'https://mailpro.alwaysdata.net/index.php/service-portal/?view=order_now&service_id=1';
        await page.goto(orderPageUrl, { waitUntil: 'networkidle2' });

        // নাম (অপশনাল) ইনপুট
        if (input_name) {
            const nameField = await page.$('input[type="text"]:not([type="hidden"])');
            if (nameField) {
                await nameField.click({ clickCount: 3 });
                await nameField.type(input_name.toString());
            }
        }

        // ড্রপডাউন সিলেক্ট
        await page.evaluate((typeVal) => {
            const sel = document.querySelector('select');
            if (sel) {
                const targetText = typeVal || 'NID NUMBER';
                for (let i = 0; i < sel.options.length; i++) {
                    if (sel.options[i].text.includes(targetText) || sel.options[i].value.includes(targetText)) {
                        sel.selectedIndex = i;
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                        break;
                    }
                }
            }
        }, data_type);

        // Digit ইনপুট
        if (input_digit) {
            const digitSelector = 'input[name="digit"], input[type="number"]';
            await page.waitForSelector(digitSelector, { visible: true, timeout: 10000 });
            const digitField = await page.$(digitSelector);
            if (digitField) {
                await digitField.click({ clickCount: 3 });
                await digitField.type(input_digit.toString());
            }
        }

        console.log('Inputs filled successfully. Submitting form with button payload...');

        // ফর্মে p_order_submit_btn ডাটা সংযুক্ত করে নিখুঁত সাবমিট
        await Promise.all([
            page.evaluate(() => {
                const form = document.querySelector('form');
                const btn = document.querySelector('#sop_order_submit_btn') || document.querySelector('button[type="submit"]');
                
                if (form) {
                    // PHP POST ডাটায় বাটনের নাম পাঠাতে হিডেন ফিল্ড যোগ
                    const hiddenInput = document.createElement('input');
                    hiddenInput.type = 'hidden';
                    hiddenInput.name = 'p_order_submit_btn';
                    hiddenInput.value = '1';
                    form.appendChild(hiddenInput);
                }

                if (btn) {
                    btn.click();
                } else if (form) {
                    form.submit();
                }
            }),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
        ]);

        console.log('Order submit action performed.');

        // ৪. নতুন অর্ডার তালিকাভুক্ত হওয়া এবং অ্যাপ্রুভালের জন্য অপেক্ষা (সর্বোচ্চ ৭ মিনিট)
        await page.goto(myOrdersUrl, { waitUntil: 'networkidle2' });

        let fileDownloadUrl = null;
        const maxWaitTime = 7 * 60 * 1000;
        const checkInterval = 10 * 1000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            let orderCheck = { isNew: false, completed: false, url: null };
            
            try {
                // Detached Frame এরর এড়াতে try-catch ব্যবহার
                orderCheck = await page.evaluate((prevRef) => {
                    const firstRow = document.querySelector('table tbody tr:first-child') || document.querySelector('table tr:nth-child(2)');
                    if (!firstRow) return { isNew: false, completed: false, url: null };

                    const currentText = firstRow.innerText.trim();
                    const isNew = currentText !== prevRef;
                    const statusText = currentText.toUpperCase();
                    const isCompleted = statusText.includes('COMPLETED');
                    const downloadBtn = firstRow.querySelector('a[href*="download"], a[href*="sop_action"]');

                    return {
                        isNew: isNew,
                        completed: isCompleted,
                        url: downloadBtn ? downloadBtn.href : null
                    };
                }, previousTopOrderReference);
            } catch (evalError) {
                console.log('Waiting for frame stabilization...');
            }

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

        // ৫. কুকি (Cookie) সেসন ব্যবহার করে ফাইল ডাউনলোড
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

        // ৭. ওয়ার্ডপ্রেসে ফাইল লিংক আপডেট পাঠানো
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
