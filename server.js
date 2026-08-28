console.log('Inputs filled successfully. Submitting form...');

        // নেটিভ ক্লিক দিয়ে AJAX ইভেন্ট ট্র্রিগার করা
        const submitBtn = await page.$('#sop_order_submit_btn, button[type="submit"], input[type="submit"]');
        
        if (submitBtn) {
            // Promise.all ব্যবহার করে একই সাথে ক্লিক করা এবং ব্যাকগ্রাউন্ড লোডিং শেষ হওয়ার অপেক্ষা করা
            await Promise.all([
                // যতক্ষণ না ২ সেকেন্ড ধরে নেটওয়ার্ক পুরোপুরি শান্ত (Idle) থাকছে, ততক্ষণ অপেক্ষা করবে
                page.waitForNetworkIdle({ idleTime: 2000, timeout: 25000 }).catch(() => console.log('Network wait timeout...')),
                // page.evaluate দিয়ে ক্লিক করাটা Puppeteer এ ফর্ম সাবমিটের ক্ষেত্রে বেশি নিরাপদ
                page.evaluate(btn => btn.click(), submitBtn)
            ]);
        } else {
            await Promise.all([
                page.waitForNetworkIdle({ idleTime: 2000, timeout: 25000 }).catch(() => {}),
                page.evaluate(() => {
                    const btn = document.querySelector('button, input[type="submit"]');
                    if(btn) btn.click();
                })
            ]);
        }

        // অতিরিক্ত নিরাপত্তার জন্য আরও ২ সেকেন্ড অপেক্ষা
        await new Promise(r => setTimeout(r, 2000));
        console.log('Order submit action performed and network loading finished.');

        // ৪. নতুন অর্ডার এবং ডাউনলোডের জন্য অপেক্ষা...
