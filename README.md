# منصة الخصوصيين — نسخة السيرفر المستقل

باك اند (Node.js) + قاعدة بيانات (SQLite) + واجهة (HTML) في مشروع واحد، بدون Supabase وبدون أي مكتبات خارجية.

**الأمان:** الخادم يتحقق من توقيع تليجرام (initData) باستخدام توكن البوت، فما أحد يقدر يزوّر هويته أو يدخل كأدمن. الأدمن = آيدي تليجرام المحدد في `.env`، وما فيه إيميل أو كلمة مرور.

## ما تحتاجه
1. **سيرفر VPS** (Ubuntu 22/24) — أي مزود: Hetzner, DigitalOcean, Contabo... يكفي 1GB رام.
2. **دومين** موجّه لعنوان السيرفر (سجل A). تليجرام يشترط HTTPS. لو ما عندك دومين تقدر تاخذ مجاني من duckdns.org.
3. **بوت تليجرام** من @BotFather، وتحتاج التوكن.

## خطوات الرفع

**1) جهّز السيرفر** (مرة وحدة)
```bash
curl -fsSL https://get.docker.com | sh
```

**2) ارفع المجلد** إلى السيرفر (مثلاً من جهازك)
```bash
scp -r barq-platform root@IP_السيرفر:/opt/
```

**3) اضبط الإعدادات**
```bash
cd /opt/barq-platform
cp .env.example .env
nano .env        # عدّل BOT_TOKEN و OWNER_ID و DOMAIN
```

**4) شغّل**
```bash
docker compose up -d --build
```
افتح `https://دومينك/healthz` ولازم يطلع `{"ok":true}`.

**5) اربطها بالبوت**
في @BotFather: `/mybots` ← اختر البوت ← **Bot Settings** ← **Menu Button** ← **Configure menu button** ← ضع رابط `https://دومينك`.

بعدها افتح البوت من حسابك: يطلع لك زر **الإدارة** تلقائياً لأن الآيدي حقك.

## الصيانة
- **تحديث الكود:** استبدل الملفات ثم `docker compose up -d --build`
- **عرض السجلات:** `docker compose logs -f app`
- **النسخ الاحتياطي:** كل البيانات في ملف واحد `data/barq.db`. انسخه دورياً:
  ```bash
  cp /opt/barq-platform/data/barq.db /root/backup-$(date +%F).db
  ```
  أو من لوحة الإدارة ← النسخ الاحتياطي (JSON).
- **إيقاف:** `docker compose down` (البيانات تبقى في `data/`)

## التشغيل بدون Docker
يحتاج Node 22.13 أو أحدث:
```bash
cp .env.example .env && nano .env
npm start
```
(وضع HTTPS يحتاج Nginx أو Caddy أمامه.)

## الإشعارات
- تجيك رسالة في تليجرام عند كل طلب تسجيل جديد أو طلب تعديل تقييم.
- الخصوصي تصله رسالة عند قبول أو رفض طلبه، والطالب عند السماح بتعديل تقييمه.
> لازم الشخص يكون فاتح البوت ومرسل `/start` مرة وحدة عشان تقدر ترسل له.

## هيكل المشروع
```
server.js        الباك اند (API + قاعدة البيانات + التحقق من تليجرام)
public/index.html   الواجهة
Dockerfile, docker-compose.yml, Caddyfile   الرفع
.env             الإعدادات السرية (لا ترفعه لأي مكان عام)
data/barq.db     قاعدة البيانات (تنشأ تلقائياً)
```
