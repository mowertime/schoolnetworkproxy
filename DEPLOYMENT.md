# Deploy to Render (Free)

## Quick Deploy Steps

1. **Push your code to GitHub**
   ```bash
   git add .
   git commit -m "Ready for deployment"
   git push origin main
   ```

2. **Sign up for Render**
   - Go to https://render.com
   - Sign up with your GitHub account (free)

3. **Create New Web Service**
   - Click "New +" → "Web Service"
   - Connect your GitHub repository: `mowertime/schoolnetworkproxy`
   - Click "Connect"

4. **Configure the service**
   - **Name**: `schoolnetworkproxy` (or your choice)
   - **Region**: Choose closest to you
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`

5. **Environment Variables** (Optional)
   - Add if needed:
     - `NODE_ENV` = `production`
     - `PORT` = `3000` (Render sets this automatically)

6. **Deploy**
   - Click "Create Web Service"
   - Wait 2-3 minutes for deployment
   - Your proxy will be live at: `https://your-service-name.onrender.com`

## Important Notes

### Free Tier Limitations
- **Sleeps after 15 minutes** of inactivity
- **Wakes automatically** when accessed (takes ~30 seconds)
- **750 hours/month** (plenty for personal use)

### Keep it Awake (Optional)
Use a free service like **UptimeRobot** or **Cron-job.org** to ping your site every 10 minutes:
- Ping URL: `https://your-service-name.onrender.com`
- Interval: Every 10-14 minutes

### Auto-Deploy
- Render automatically redeploys when you push to GitHub
- No manual steps needed after initial setup

## Testing Your Deployment

1. Visit: `https://your-service-name.onrender.com`
2. Try proxying a site: `https://your-service-name.onrender.com/p/https/example.com`
3. Use the search interface to browse

## Troubleshooting

**Service won't start?**
- Check Render logs: Dashboard → Your Service → Logs
- Verify `package.json` has correct start script

**Slow first load?**
- Normal! Free tier sleeps after inactivity
- Takes 30-60 seconds to wake up

**Out of hours?**
- Free tier has 750 hours/month
- Consider using UptimeRobot pings strategically
- Or let it sleep when not in use

## Alternative Free Hosts

If Render doesn't work for you:
1. **Railway** - $5 free credit/month (no card)
2. **Fly.io** - Free tier (needs card for verification)
3. **Glitch** - Free (sleeps after 5 min)
4. **Replit** - Free (can stay awake with UptimeRobot)
