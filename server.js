const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const BOT_SECRET_KEY = process.env.BOT_SECRET_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; 
const WP_SITE_URL = process.env.WP_SITE_URL;

app.get('/', (req, res) => {
    res.send('Automation Bot is Running Live!');
});

app.post('/process-order', async (req, res) => {
    const { order_id, secret_key, download_url, user_id } = req.body;

    if (secret_key !== BOT_SECRET_KEY) {
        return res.status(403).json({ success: false, message: 'Invalid Bot Secret Key' });
    }

    res.status(200).json({ success: true, message: 'Processing started' });

    try {
        const fileResponse = await axios.get(download_url, { responseType: 'arraybuffer' });
        const fileBuffer = Buffer.from(fileResponse.data);
        const fileName = `order_${order_id}_${Date.now()}.pdf`;

        const githubUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/downloads/${fileName}`;
        
        const ghResponse = await axios.put(githubUrl, {
            message: `Auto Upload Order #${order_id}`,
            content: fileBuffer.toString('base64')
        }, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github+json'
            }
        });

        const rawDownloadUrl = ghResponse.data.content.download_url;

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
        console.error(`Error Order #${order_id}:`, error.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Bot active on port ${PORT}`));
