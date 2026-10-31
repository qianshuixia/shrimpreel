// 英文文案。所有关键词/品牌通过 site 配置插值，上新词时通常只需改 site.ts；
// 文章与 FAQ 建议按新趋势重写，保证内容原创、贴合关键词。
import type { ArticleKey, site as Site } from '#/config/site'

type S = typeof Site
type StyleId = S['styles'][number]['id']
type StyleCopy = { name: string; tagline: string }
type ArticleContent = { title: string; description: string; intro: string; sections: Array<{ h: string; p: string[] }> }
// FAQ 答案可附一条文章链接；锚文本用与文章标题不同的长尾词
type FaqItem = { q: string; a: string; guide?: { article: ArticleKey; label: string } }
// 首页可选转化区块，设为 null 就不渲染。痛点只写不用本站时的麻烦，不提产品；对比逐行写“自己做”和“用本站”，不承诺生成效果
type ProblemBlock = { eyebrow: string; title: string; items: Array<{ title: string; body: string }> }
type WithWithoutBlock = { eyebrow: string; title: string; without: string; with: string; rows: Array<{ without: string; with: string }> }

export function en(s: S) {
  const k = s.keyword
  // 是否在卖订阅（site.subscriptionsEnabled 且有套餐），决定订阅相关文案是否出现
  const subs = s.subscriptionsEnabled && s.plans.length > 0
  const b = s.brandName
  const { uploadDays, outputDays } = s.retention
  const photoRetention = uploadDays > 0 ? `deleted automatically ${uploadDays} days after upload` : 'kept until you delete them'
  const videoRetention = outputDays > 0 ? `kept for ${outputDays} days after they finish` : 'kept until you delete them'
  const { ga4Id, cfBeaconToken, umamiWebsiteId, clarityId } = s.analytics
  // 每种风格的展示名和一句话介绍；site.styles 加风格时这里补一项（缺了 typecheck 报错），zh.ts 同
  const styles: Record<StyleId, StyleCopy> = {
    'neon-shuffle-v1': { name: k, tagline: 'The original routine, beat for beat.' },
  }
  return {
    styles,
    meta: {
      // 首页 title 不加品牌后缀：品牌通常已含关键词，控制在 60 字符内（seo:check 会校验）
      homeTitle: `${k} AI Video Generator from One Photo`,
      homeDescription: `Upload one photo and get your own ${k} video in minutes. Same choreography, same framing, starring you. ${subs ? 'Buy credits once or subscribe monthly.' : 'Pay per video with credits that never expire.'}`,
      pricingTitle: `Pricing – ${b}`,
      pricingDescription: subs
        ? `Credit packs and monthly or yearly plans for ${k} AI videos. Pack credits never expire, cancel a plan anytime, failed renders are refunded automatically.`
        : `Simple credit packs for ${k} AI videos. Pay once, credits never expire, failed renders are refunded automatically.`,
      contactTitle: `Contact – ${b}`,
      contactDescription: `Questions about billing, refunds, a failed render or partnerships? Reach the ${b} team, we usually reply within one business day.`,
      signInTitle: `Sign in – ${b}`,
      dashboardTitle: `My videos – ${b}`,
      privacyDescription: `How ${b} collects, uses and protects the photos, videos and account data behind your ${k} AI videos.`,
      termsDescription: `The rules for creating ${k} AI videos with ${b}: consent, acceptable use, credits and liability.`,
      refundDescription: `When ${b} returns credits or refunds a credit pack, and how long refunds take to arrive.`,
      reportTitle: `Report content – ${b}`,
      reportDescription: `Report a ${b} video that shows you without consent, involves a minor or infringes your rights. We review every report within ${s.takedownSlaHours} hours.`,
      ogImageAlt: `${b}: turn one photo into your own ${k} video`,
      breadcrumbHome: 'Home',
    },
    alt: {
      inputPhoto: `Example input photo for a ${k} AI video`,
    },
    nav: {
      features: 'Features',
      examples: 'Examples',
      pricing: 'Pricing',
      signIn: 'Sign in',
      dashboard: 'My videos',
      billing: 'Billing',
      settings: 'Settings',
      admin: 'Admin',
      signOut: 'Sign out',
      language: 'Language',
      toggleTheme: 'Toggle theme',
      credits: (n: number) => `${n} credits`,
      menu: 'Menu',
    },
    hero: {
      title: `${k} AI Video Generator`,
      subtitle: `Turn a single selfie into your own take on the ${k} clip. We keep the choreography, timing and framing of the original and cast you as the lead.`,
      badge: `Trending on ${s.trendPlatform}`,
      original: 'Original',
      aiVersion: 'AI version',
      chips: ['Same choreography', 'Same framing', 'You as the lead'],
      creditNote: 'Sample clips are placeholders made for this demo.',
    },
    generator: {
      // 只给读屏用（sr-only），不放关键词，避免隐藏文字堆词
      title: 'Create your video',
      stepPhoto: 'Your photo',
      dropTitle: 'Drop a photo or click to upload',
      dropHint: 'JPG, PNG or WebP · up to 10 MB',
      guidance: 'Best results: one person, facing the camera, even lighting, head and shoulders visible. Avoid sunglasses, masks and heavy filters.',
      change: 'Change photo',
      uploading: 'Uploading…',
      uploaded: 'Photo ready',
      stepStyle: 'Dance style',
      stepLength: 'Length',
      seconds: (n: number) => `${n} s`,
      full: 'full',
      creditsLabel: (n: number) => `${n} credits`,
      consent: 'This photo is of me, or I have permission from the person in it. They are 18 or older and not a celebrity or public figure.',
      ctaSignUp: 'Sign up free and start',
      ctaGenerate: (n: number) => `Generate video · ${n} credits`,
      ctaBuy: 'Get credits to generate',
      ctaBuyPack: (credits: number, price: string) => `Get ${credits} credits · ${price}`,
      seePacks: 'See all packs',
      balance: (n: number) => `Balance: ${n} credits`,
      needMore: (n: number) => `You need ${n} more credits for this length.`,
      needPhoto: 'Add a photo first.',
      needConsent: 'Please confirm the consent box.',
      queued: 'In the queue…',
      processing: 'Rendering your video. This usually takes a few minutes; you can leave this page.',
      succeeded: 'Your video is ready',
      failed: 'This render failed.',
      refunded: 'The credits have been returned to your balance.',
      download: 'Download MP4',
      viewAll: 'Open My videos',
      makeAnother: 'Make another',
      aiNotice: 'This video is AI-generated. Keep the label and say it is AI when you share it.',
      expiresOn: (date: string) => `Download it before ${date}. Videos are deleted automatically after that.`,
    },
    madeWith: {
      eyebrow: `Made with ${b}`,
      title: 'One photo in, one finished clip out',
      body: 'No editing timeline, no green screen. Upload a clear photo, choose a length and the render keeps every beat of the original routine.',
      photoLabel: 'Uploaded photo',
      resultLabel: 'Generated clip',
    },
    problem: {
      eyebrow: 'The catch',
      title: `Joining the ${k} trend is harder than it looks`,
      items: [
        { title: 'You have to learn the routine', body: 'Getting every move right takes real practice, and nerves still show once the camera is rolling.' },
        { title: 'Someone has to film it', body: 'You need a friend or a tripod, plus a background that matches the framing of the original.' },
        { title: 'The timing is unforgiving', body: 'Half a beat late looks obvious next to the original, so it turns into take after take.' },
      ],
    } as ProblemBlock | null,
    withWithout: {
      eyebrow: 'Side by side',
      title: `Filming it yourself vs. using ${b}`,
      without: 'Filming it yourself',
      with: `With ${b}`,
      rows: [
        { without: 'Learn the choreography first', with: 'No dancing needed, one photo is enough' },
        { without: 'Find a friend or set up a tripod', with: 'No camera setup' },
        { without: 'Retake until the timing lines up', with: 'Timing follows the original clip' },
        { without: 'Edit and export on your phone', with: 'Download a finished MP4' },
      ],
    } as WithWithoutBlock | null,
    // 首页关键词区块（one-page SEO）：H2 带关键词，上新词时按趋势本身重写 whatIs
    howTo: {
      eyebrow: 'How it works',
      title: `How to make a ${k} AI video in 3 steps`,
      steps: [
        { title: 'Upload one clear photo', body: 'One person, facing the camera, in even light. JPG, PNG or WebP up to 10 MB.' },
        { title: 'Choose a length', body: 'Take a short hook or the full routine. One credit covers one second of video.' },
        { title: 'Generate and download', body: 'The render finishes in a few minutes. Download the MP4 without a watermark and post it anywhere.' },
      ],
      cta: 'Start with your photo',
      guide: 'Read the step-by-step guide',
    },
    whatIs: {
      eyebrow: 'About the trend',
      title: `What is ${k}?`,
      paragraphs: [
        `${k} is a short vertical clip that people re-create with their own face and style. The routine is quick, the beat is easy to recognise and the camera stays on a single performer, so every new version instantly reads as part of the trend.`,
        `${b} is an AI dance video generator built around that one clip. Instead of learning the steps and filming, you upload a single photo and the model renders you performing the original routine with the same timing and framing.`,
      ],
      guide: `Read the full ${k} trend guide`,
    },
    features: {
      eyebrow: 'Features',
      title: `Everything you need for a ${k} clip`,
      items: [
        { title: 'One photo is enough', body: 'A single clear selfie is all the model needs to rebuild you inside the routine.' },
        { title: 'Faithful motion', body: 'Every step, pause and camera move follows the reference clip frame by frame.' },
        { title: 'Vertical and ready to post', body: `Exports in ${s.template.aspectRatio} so it drops straight into Reels, Shorts or ${s.trendPlatform}.` },
        { title: 'Pick your length', body: 'Grab a short hook or the full routine. You only pay for the seconds you render.' },
        { title: 'Private by default', body: `Uploads are stored privately, used only for your render and ${photoRetention}.` },
        {
          title: 'Fair billing',
          body: subs
            ? 'Credit packs never expire and plans can be canceled anytime. If a render fails, the credits go straight back to your balance.'
            : 'Credits never expire. If a render fails, the credits go straight back to your balance.',
        },
      ],
    },
    ideas: {
      eyebrow: 'Ideas',
      title: 'What people make with it',
      items: [
        { title: 'Surprise the group chat', body: 'Drop yourself into the routine and send it before anyone else jumps on the trend.' },
        { title: 'Birthday shout-outs', body: 'Use a friend’s photo (with their OK) and turn it into a dance-floor greeting card.' },
        { title: 'Creator content in minutes', body: 'Ride the trend on your channel without filming, lighting or learning the steps.' },
      ],
      cta: 'Try it with your photo',
    },
    pricing: {
      eyebrow: 'Pricing',
      title: subs ? 'Pay as you go, or subscribe' : 'Pay once, use whenever',
      subtitle: subs
        ? '1 credit = 1 second of video. Buy a pack that never expires, or subscribe for a fresh allowance every month.'
        : '1 credit = 1 second of video. No subscription, no expiry.',
      popular: 'Most popular',
      // 锚定价（site.packages[].anchorPriceCents）的划线原价和折扣
      was: 'Regular price',
      save: (percent: number) => `Save ${percent}%`,
      buy: 'Buy credits',
      buying: 'Opening checkout…',
      // 后台“暂停收款”打开时代替购买按钮和价格说明
      paused: 'Payments opening soon',
      pausedNote: 'We’re finishing setup with our payment partner, so purchases aren’t open yet. Check back soon.',
      credits: (n: number) => `${n} credits`,
      makes: (items: { videos: number; seconds: number }[]) =>
        `Makes ${items.map((i) => `${i.videos} × ${i.seconds}s`).join(' or ')} ${items.length === 1 && items[0]!.videos === 1 ? 'video' : 'videos'}`,
      bullets: ['Credits never expire', 'All video lengths', 'HD MP4 download, no watermark', 'Automatic refund on failed renders'],
      note: 'Prices in USD. Taxes are calculated at checkout by our payment partner.',
      // 价格页底部的教程链接
      guide: `Before you buy: how to get a great ${k} video`,
      packages: {
        starter: { name: 'Starter', tagline: 'Try the trend' },
        party: { name: 'Party', tagline: 'For you and your friends' },
        squad: { name: 'Squad', tagline: 'For creators and teams' },
      } as Record<string, { name: string; tagline: string }>,
      // 订阅套餐（site.plans）
      plansTitle: 'Subscriptions',
      plansBody: 'Credits are added at the start of every month of your plan and expire when that month ends. Cancel anytime and keep your plan until the period ends.',
      packsTitle: 'Credit packs',
      perMonth: '/ month',
      perYear: '/ year',
      monthlyCredits: (n: number) => `${n} credits every month`,
      yearlyMonthly: (price: string) => `${price} / month, billed yearly`,
      subscribe: 'Subscribe',
      planBullets: ['Credits refresh every month', 'All video lengths', 'HD MP4 download, no watermark', 'Cancel anytime'],
      plans: {
        monthly: { name: 'Monthly', tagline: 'Flexible, cancel anytime' },
        yearly: { name: 'Yearly', tagline: 'Best value for regular creators' },
      } as Record<string, { name: string; tagline: string }>,
      renewalNote: 'Subscriptions renew automatically at the price shown until you cancel. Unused monthly credits do not roll over.',
    },
    faq: {
      title: 'Questions, answered',
      body: 'Still unsure? Our team replies within one business day.',
      cta: 'Contact support',
      items: [
        {
          q: `What is ${b}?`,
          a: `${b} is an online tool that recreates the ${k} video with you as the performer, using just one photo.`,
          guide: { article: 'trend', label: `Where the ${k} clip came from` },
        },
        {
          q: 'Which photo works best?',
          a: 'A recent photo of one person facing the camera, with even light and the head and shoulders in frame. Group shots, sunglasses and strong filters lower the quality.',
          guide: { article: 'howTo', label: `Photo tips for a better ${k} AI video` },
        },
        { q: 'How long does a render take?', a: 'Most videos finish in 2–8 minutes depending on length and queue. You can close the page; finished videos wait in My videos.' },
        {
          q: 'How do credits work?',
          a: subs
            ? 'Each second of video costs one credit. Credits from packs never expire; subscription credits are added every month and expire at the end of that month. Renders use the credits that expire soonest first, and credits are refunded automatically if a render fails.'
            : 'Each second of video costs one credit. Credits are bought in packs, never expire and are refunded automatically if a render fails.',
        },
        ...(subs
          ? [{ q: 'How do I cancel my subscription?', a: 'Open My account → Billing and choose Cancel renewal. You won’t be charged again, and your plan and credits stay available until the end of the current period.' }]
          : []),
        { q: 'Can I use someone else’s photo?', a: 'Only with their permission, and never photos of minors, celebrities or public figures. Accounts that break this rule are closed.' },
        { q: 'What happens to my photos?', a: `Uploads are private, used only to make your video and ${photoRetention}. Finished videos are ${videoRetention}. Deleting your account removes everything right away.` },
      ] as FaqItem[],
    },
    finalCta: {
      title: `Your ${k} moment is one photo away`,
      body: 'Upload a selfie, pick a length and watch yourself take the lead.',
      cta: 'Create my video',
    },
    footer: {
      statement: `${b} is an independent project and is not affiliated with ${s.trendPlatform} or the creators of the original trend.`,
      resources: 'Resources',
      legal: 'Legal',
      contact: 'Contact',
      privacy: 'Privacy Policy',
      terms: 'Terms of Service',
      refund: 'Refund Policy',
      report: 'Report content',
      rights: `© ${new Date().getFullYear()} ${b}. All rights reserved.`,
      // 页脚“问问 AI”：llms.txt 链接 + 几个带预填提问的 AI 按钮
      agentDocs: 'AI & agent docs',
      askAi: `See what ChatGPT, Claude, Perplexity, Gemini or Grok say about ${b}.`,
      askAiLabel: (ai: string) => `Ask ${ai} about ${b}`,
      askAiPrompt: (url: string, llms: string) => `What is ${b} (${url})? Summarize what it does, how pricing works and who it is for. Site summary for AI: ${llms}`,
    },
    support: { label: 'Help & support' },
    // 统计同意横幅：只在配置了 GA4 时出现
    consent: {
      title: 'Analytics cookies',
      body: clarityId
        ? `We use ${ga4Id ? 'Google Analytics, ' : ''}Microsoft Clarity session recordings and a first-party referral cookie to see how the site is used. Until you accept, Clarity records without cookies and nothing else is set; change it any time under “Cookie settings”.`
        : 'We use Google Analytics and a first-party referral cookie to see how the site is used. Nothing is set unless you accept; change it any time under “Cookie settings”.',
      learnMore: 'Privacy Policy',
      accept: 'Accept',
      reject: 'Reject',
      settings: 'Cookie settings',
      // × 只收起本次，不记录选择
      dismiss: 'Dismiss',
    },
    signIn: {
      title: `Sign in to ${b}`,
      body: 'Use your Google account. New here? An account is created automatically.',
      google: 'Continue with Google',
      devTitle: 'Developer login (local only)',
      devEmail: 'Email',
      devSubmit: 'Sign in as this email',
      legal: 'By continuing you agree to our Terms of Service and Privacy Policy.',
      notConfigured: 'Google sign-in is not configured yet.',
    },
    dashboard: {
      title: 'My account',
      tabs: { videos: 'Videos', billing: 'Billing', settings: 'Settings' },
      buyCredits: 'Buy credits',
      newVideo: 'New video',
      empty: 'No videos yet. Upload a photo on the home page to make your first one.',
      status: { queued: 'Queued', processing: 'Rendering', succeeded: 'Ready', failed: 'Failed', expired: 'Expired', removed: 'Removed' } as Record<string, string>,
      refundedNote: 'Credits refunded',
      delete: 'Delete',
      confirmDelete: 'Delete this video permanently?',
      download: 'Download',
      seconds: (n: number) => `${n} s`,
      expired: 'Expired and deleted',
      removed: 'Removed after a content report',
      expiresOn: (date: string) => `Available until ${date}`,
      share: 'Share',
      confirmShare: 'Create a public link to this video? Anyone with the link can watch it. Your name and email are not shown, and you can stop sharing at any time.',
      sharedNote: 'Anyone with the link can watch this video.',
      openSharePage: 'Open page',
      copyLink: 'Copy link',
      linkCopied: 'Copied',
      copyPrompt: 'Copy this link:',
      stopSharing: 'Stop sharing',
      confirmStopSharing: 'Stop sharing? The current link will stop working for everyone.',
    },
    billing: {
      orders: 'Orders',
      ledger: 'Credit history',
      noOrders: 'No orders yet.',
      noLedger: 'No credit activity yet.',
      expiring: (credits: number, date: string) => `${credits} ${credits === 1 ? 'credit expires' : 'credits expire'} on ${date}.`,
      expiringHint: 'Renders use the credits that expire soonest first.',
      columns: { date: 'Date', pack: 'Pack', amount: 'Amount', status: 'Status', change: 'Change', reason: 'Reason' },
      orderStatus: { pending: 'Pending', paid: 'Paid', partially_refunded: 'Partially refunded', failed: 'Failed', refunded: 'Refunded', canceled: 'Canceled' } as Record<string, string>,
      refundedLine: (amount: string, credits: number) => `Refunded ${amount} · ${credits} credits`,
      details: 'Details',
      loadMore: 'Load more',
      order: {
        title: 'Order details',
        back: 'Back to billing',
        orderId: 'Order ID',
        status: 'Status',
        pack: 'Pack',
        price: 'Price',
        amountPaid: 'Amount paid',
        refunded: 'Refunded',
        created: 'Created',
        paidAt: 'Paid on',
        refundedAt: 'Refunded on',
        provider: 'Payment processor',
        providers: { waffo: 'Waffo', dodo: 'Dodo Payments', stripe: 'Stripe', mock: 'Test checkout' } as Record<string, string>,
        print: 'Print',
        invoiceNote: 'Payments are handled by our payment processor as the merchant of record, and it emails your receipt or tax invoice. Can’t find it? Contact support with this order ID.',
        mockNote: 'This is a test order from the local mock checkout. No money was charged and no invoice is issued.',
        unpaidNote: 'This order was not paid. If you were charged anyway, contact support with this order ID.',
        contact: 'Contact support',
      },
      reasons: {
        purchase: 'Credit purchase',
        generation: 'Video render',
        generation_refund: 'Failed render refund',
        order_refund: 'Order refunded',
        admin_adjust: 'Adjustment by support',
        expire: 'Credits expired',
        redeem: 'Redeem code',
        referral: 'Referral reward',
        referral_refund: 'Referral reward reversed (order refunded)',
        signup_bonus: 'Welcome bonus',
        account_deleted: 'Account deleted',
        subscription: 'Subscription credits',
      } as Record<string, string>,
      subscription: {
        title: 'Subscription',
        status: { active: 'Active', past_due: 'Payment failed', canceled: 'Canceled', expired: 'Ended' } as Record<string, string>,
        monthlyCredits: (n: number) => `${n} credits every month`,
        renewsOn: (date: string, price: string) => `Renews on ${date} for ${price}.`,
        endsOn: (date: string) => `Canceled. Your plan stays active until ${date} and you won’t be charged again.`,
        ended: (date: string) => `Ended on ${date}.`,
        nextGrant: (date: string) => `Next monthly credits on ${date}.`,
        pastDue: 'Your renewal payment failed. Update your payment method to keep your plan; the payment will be retried automatically.',
        cancel: 'Cancel renewal',
        confirmCancel: 'Cancel renewal? You keep your plan and credits until the end of the current period.',
        resume: 'Keep my plan',
        resumeInPortal: 'Changed your mind? Open Manage payment to resume your plan.',
        portal: 'Manage payment',
        seePlans: 'See plans',
      },
    },
    settings: {
      profile: 'Profile',
      email: 'Email',
      memberSince: 'Member since',
      signOut: 'Sign out',
      dataTitle: 'Your data',
      dataBody: 'Download a JSON copy of your account, orders, credit history, uploads, generations, messages and reports. Video files are not included; download them from your dashboard while they are kept.',
      dataButton: 'Export my data',
      dangerTitle: 'Delete account',
      dangerBody: 'Deletes your uploads and videos and signs you out everywhere. Remaining credits are forfeited. Order records are kept for accounting. Signing up again with the same email does not include the sign-up bonus.',
      confirmLabel: 'Type DELETE to confirm',
      deleteButton: 'Delete my account',
      redeemTitle: 'Redeem a code',
      redeemBody: 'Have a promo or gift code? Enter it to add credits to your account. Each code can be used once per account.',
      redeemButton: 'Redeem',
      redeemSuccess: (credits: number, expires: string | null) =>
        `Added ${credits} ${credits === 1 ? 'credit' : 'credits'}${expires ? `, valid until ${expires}` : ''}.`,
      referralTitle: 'Invite friends',
      referralBody: (credits: number) =>
        `Share your link. When a friend signs up through it and makes their first purchase, you get ${credits} ${credits === 1 ? 'credit' : 'credits'}. If that order is refunded, the reward is taken back.`,
      referralCopy: 'Copy link',
      referralCopied: 'Copied',
      referralStats: (invited: number, rewarded: number, credits: number) =>
        `Signed up: ${invited} · Purchased: ${rewarded} · Credits earned: ${credits}`,
    },
    checkout: {
      successTitle: 'Payment received',
      pendingTitle: 'Confirming your payment…',
      pendingBody: 'This usually takes a few seconds. You can keep this tab open.',
      failedTitle: 'Payment was not completed',
      failedBody: 'No charge was made. You can try again from the pricing page.',
      added: (n: number) => `${n} credits were added to your balance.`,
      slowBody: 'Still waiting for the payment provider. Credits will appear automatically; if they don’t within an hour, contact support with your order ID.',
      orderId: 'Order ID',
      start: 'Start creating',
      backToPricing: 'Back to pricing',
      mockTitle: 'Test checkout',
      mockBody: 'This is the local mock payment provider. Nothing is charged.',
      mockPay: 'Simulate successful payment',
      mockFail: 'Simulate failed payment',
    },
    contact: {
      title: 'Contact us',
      body: `Write to ${s.supportEmail} or use the form below. Include your order ID for billing questions.`,
      email: 'Your email',
      topic: 'Topic',
      topics: { general: 'General', billing: 'Billing', bug: 'Bug report', partnership: 'Partnership' } as Record<string, string>,
      message: 'Message',
      send: 'Send message',
      sent: 'Thanks! We’ll get back to you soon.',
      guides: `Photo tips and trend background: browse the ${k} guides`,
    },
    report: {
      title: 'Report content or request removal',
      body: `If a video made with ${b} shows you without your consent, involves a minor, impersonates someone or infringes your rights, tell us here. A person reviews every report and qualifying content is removed within ${s.takedownSlaHours} hours. Removed photos are blocked from being uploaded again.`,
      name: 'Your full name (serves as your electronic signature)',
      email: 'Email we can reach you at',
      contentRef: 'Where is the content?',
      contentRefHint: 'Paste a link or the file name (downloaded files contain an ID such as gen_…), or describe where you saw it.',
      reason: 'Reason',
      reasons: {
        intimate: 'Intimate or sexual content without consent',
        impersonation: 'Impersonation or a deceptive deepfake',
        minor: 'It shows a minor',
        copyright: 'Copyright or trademark',
        other: 'Something else',
      } as Record<string, string>,
      details: 'Details (optional)',
      isDepicted: 'I am the person shown, or I am authorised to act on their behalf.',
      attest: 'I believe in good faith that this content was made or shared without the consent of the person shown, and the information in this report is accurate.',
      submit: 'Send report',
      sent: (id: string) => `Report received. Your reference is ${id}. We may contact you at the email above if we need more information.`,
      urgent: 'If someone is in immediate danger, contact local emergency services. Child sexual abuse material should also be reported to the NCMEC CyberTipline or your national hotline.',
      cybertip: 'NCMEC CyberTipline',
    },
    // 成片公开分享页 /v/<id>
    share: {
      title: `An AI video made with ${b}`,
      goneTitle: `Video unavailable – ${b}`,
      description: `Watch this AI-generated ${k} video, then turn one photo into your own.`,
      heading: `Made with ${b}`,
      body: `This ${k} video was generated by AI from a single photo. Upload yours to make your own.`,
      disclosure: 'This video is AI-generated and does not show real events.',
      cta: 'Make your own',
      reportPrompt: 'Shows you without consent or breaks our rules?',
      report: 'Report this video',
      gone: { missing: 'This link doesn’t work', expired: 'This video has expired', removed: 'This video was removed' },
      goneBody: 'The video may have been deleted or expired, or its owner stopped sharing it.',
    },
    common: {
      loading: 'Loading…',
      retry: 'Try again',
      home: 'Back to home',
      notFoundTitle: 'Page not found',
      notFoundBody: 'The page you are looking for does not exist or has moved.',
      errorTitle: 'Something went wrong',
      errorBody: `Please try again. If it keeps happening, email ${s.supportEmail}.`,
      errorRef: (id: string) => `Error ID: ${id} (include it when you contact us)`,
      signInRequired: 'Please sign in to continue.',
      lastUpdated: 'Last updated',
      aiGenerated: 'AI-generated',
      breadcrumb: 'Breadcrumb',
      maintenance: 'We’re doing some maintenance. New videos and purchases are paused for a short while; your videos and credits are safe.',
    },
    // 文章列表页 /guides
    guides: {
      nav: 'Guides',
      title: `${k} guides`,
      metaTitle: `${k} AI Video Guides – ${b}`,
      description: `Guides to the ${k} trend and to making your own ${k} AI video: where it came from, which photos work best and step-by-step tips.`,
      intro: `Background on the ${k} trend and practical tips for turning one photo into a ${k} AI video.`,
      related: 'Related guides',
    },
    errors: {
      unauthorized: 'Please sign in first.',
      insufficient_credits: 'Not enough credits for this length.',
      invalid_code: 'This code is invalid or has expired.',
      code_used_up: 'This code has been fully redeemed.',
      already_redeemed: 'You have already redeemed this code.',
      too_many_active_jobs: 'You already have 3 videos rendering. Please wait for one to finish.',
      maintenance: 'We’re doing some maintenance. Please try again in a little while.',
      checkout_paused: 'Payments aren’t open yet. Please check back soon.',
      daily_limit: 'We’ve hit today’s rendering capacity. Please try again tomorrow; your credits were not used.',
      rate_limited: 'Too many requests. Please wait a minute and try again.',
      file_too_large: 'That file is larger than 10 MB.',
      length_required: 'Your browser sent the file in a way we can’t accept. Please try again in another browser.',
      unsupported_file_type: 'Please upload a JPG, PNG or WebP image.',
      invalid_upload: 'Please upload the photo again.',
      invalid_style: 'That dance style isn’t available. Please pick another one.',
      queue_unavailable: 'Our render queue is busy. Your credits were returned; please try again.',
      payment_not_configured: 'Payments are not available right now.',
      payment_provider_error: 'The payment provider did not respond. Please try again.',
      invalid_email: 'Please enter a valid email address.',
      invalid_message: 'Please write between 10 and 5000 characters.',
      generation_in_progress: 'This video is still rendering.',
      google_not_configured: 'Google sign-in is not configured.',
      oauth_state: 'Sign-in expired. Please try again.',
      oauth_failed: 'Google sign-in failed. Please try again.',
      network_error: 'Network error. Check your connection and try again.',
      content_rejected: 'This photo can’t be used. Choose a different photo that follows our content rules.',
      moderation_unavailable: 'We couldn’t check this photo right now. Please try again in a minute.',
      moderation_not_configured: 'Uploads are temporarily unavailable.',
      captcha_required: 'Please complete the verification.',
      captcha_failed: 'Verification failed. Please try again.',
      captcha_unavailable: 'The verification service is unavailable. Please try again.',
      captcha_not_configured: `Verification is not available. Please email ${s.supportEmail} instead.`,
      media_expired: 'This video has expired and was deleted.',
      subscription_exists: 'You already have an active subscription. Manage it under My account → Billing.',
      subscription_active: 'Cancel your subscription renewal under Billing before deleting your account.',
      subscription_not_found: 'No active subscription was found.',
      subscription_resume_in_portal: 'Open Manage payment to resume your plan.',
      subscription_portal_unsupported: 'Payment management isn’t available for this subscription. Please contact support.',
      subscription_cancel_unsupported: 'This subscription can’t be canceled here. Please contact support.',
      media_removed: 'This video was removed after a content report.',
      share_rejected: 'This video can’t be shared publicly because it didn’t pass our content check.',
      invalid_report: 'Please fill in every required field and confirm the statement.',
      not_found: 'We couldn’t find that. It may belong to a different account.',
      internal_error: 'Unexpected error. Please try again.',
      account_disabled: `This account has been disabled. Email ${s.supportEmail} if you think this is a mistake.`,
      account_conflict: `This email is linked to a different Google account. Sign in with that account, or email ${s.supportEmail} for help.`,
    } as Record<string, string>,
    legal: {
      updated: '2026-10-21',
      privacy: {
        title: 'Privacy Policy',
        sections: [
          { h: 'What we collect', p: [`When you sign in we receive your name, email address and profile picture from Google. When you create a video we store the photo you upload and the video we generate. Payment details are handled by our payment partner; ${b} never sees your card number.`] },
          { h: 'How we use it', p: ['Your photo is used only to render the video you request. We use your email to operate your account, send receipts and service notices (such as when your video is ready or a report you filed is resolved) and answer support requests. We do not send marketing email. We do not sell personal data and do not use your photos to train models.'] },
          { h: 'Storage and retention', p: [`Files are stored with our infrastructure provider in encrypted form. Uploaded photos are ${photoRetention} and generated videos are ${videoRetention}, unless you delete them or your account sooner. Order and payment records are kept as required for tax and accounting. When you delete your account we keep only a one-way hash of your email address, so the same email cannot claim the sign-up bonus twice.`] },
          { h: 'Safety checks', p: ['Before a photo is used it may be checked by an automated content-safety classifier. The check runs only to enforce our rules, and its result is not used for anything else. Public forms are protected by a bot-detection service that may process your IP address and browser signals.'] },
          {
            h: 'Cookies and analytics',
            p: [
              'The site uses a few cookies and similar browser storage that it needs to work, such as your sign-in session and your light or dark theme preference.',
              'We also set a first-party cookie (vt_attr, kept for 90 days) that records how you first and most recently reached us, such as a referring website or campaign link. We use it only to see which channels lead to sign-ups and purchases, and we do not share it with advertising networks.' +
                (ga4Id || clarityId ? ' It is only set after you accept analytics cookies in the banner, and withdrawing consent deletes it.' : ''),
              s.referralRewardCredits > 0
                ? 'If you open a friend’s invite link, we set a cookie (vt_ref, kept for up to 30 days and removed once you sign up) so the invite can be credited. To prevent abuse of invite rewards, we store a salted hash of your IP address with the invite, not the address itself. Neither of you can see the other’s account details.'
                : '',
              ga4Id || cfBeaconToken || umamiWebsiteId || clarityId ? '' : 'We do not use third-party analytics or advertising cookies.',
              cfBeaconToken ? 'We count page views with Cloudflare Web Analytics, which does not use cookies or track you across websites.' : '',
              umamiWebsiteId
                ? 'We count visits with Umami, a cookie-free analytics tool loaded from our own domain. It does not set cookies or store your IP address; your IP address is only used to determine your country and to count unique visits.'
                : '',
              clarityId
                ? 'We use Microsoft Clarity to understand how visitors use the site through heatmaps and session recordings of clicks, scrolling and page changes. Text you type into forms is masked and not recorded. Until you accept analytics cookies, Clarity sets no cookies and cannot link one page view to the next; if you accept, it sets cookies (such as _clck and _clsk) to connect your visits. Microsoft processes this data, including your IP address and device information, on our behalf. Withdrawing consent under “Cookie settings” in the footer deletes these cookies.'
                : '',
              ga4Id
                ? 'If you accept analytics cookies in the banner, we also use Google Analytics. It sets cookies (such as _ga) and lets Google process your IP address and device information to produce usage reports for us. Google Analytics is not loaded until you accept. You can withdraw consent at any time under “Cookie settings” in the footer, which also deletes these cookies.'
                : '',
            ].filter(Boolean),
          },
          ...(s.share.enabled
            ? [
                {
                  h: 'Shared videos',
                  p: [
                    'If you share a video, anyone with the link can watch it. The share page does not show your name or email and asks search engines not to index it. To make link previews, your browser takes a still frame from the video and we store it with the video. Stopping sharing or deleting the video disables the link and deletes that image; the link also stops working when the video expires or is removed after a report.',
                  ],
                },
              ]
            : []),
          { h: 'Service providers', p: [`We rely on a small number of processors: cloud hosting, storage and email delivery, an AI rendering provider that processes your photo only for your request, a content-safety classifier, a payment provider acting as merchant of record${ga4Id || cfBeaconToken || umamiWebsiteId || clarityId ? ', and the analytics services described above' : ''}.`] },
          { h: 'Your rights', p: [`You can download or delete your videos at any time. In Settings you can export a copy of your data as JSON or delete your account. For any other privacy request, email ${s.supportEmail}.`] },
        ],
      },
      terms: {
        title: 'Terms of Service',
        sections: [
          { h: 'Using the service', p: [`${b} lets you create short AI videos from a photo. You must be at least 18 years old, or the age of majority where you live, to use it.`] },
          { h: 'Your content and consent', p: ['Only upload photos of yourself or of adults who have given you permission. Do not upload photos of minors, celebrities or public figures, and do not use the service to harass, impersonate or deceive anyone. We may remove content and close accounts that break these rules.'] },
          { h: 'Generated videos', p: ['You may use the videos you create for personal and social media purposes. AI output can contain mistakes; review a video before sharing it. Videos are labelled as AI-generated: keep that label, say the video is AI-generated when you share it and never present it as real footage of an event.'] },
          { h: 'Reports and removal', p: [`Anyone can report content through our report page. We review reports and remove content that breaks these terms or someone’s rights within ${s.takedownSlaHours} hours. Removed photos are blocked from being uploaded again, and accounts involved in serious or repeated violations may be closed without a refund of used credits.`] },
          {
            h: 'Credits and payments',
            p: [
              'Credit packs are one-time purchases. Credits have no cash value, and credits from packs do not expire while the service is operating. Payments are processed by our merchant-of-record partner, whose terms also apply.',
              subs
                ? 'Subscriptions renew automatically at the end of each billing period (monthly or yearly) at the price you subscribed at, until you cancel. You can cancel at any time under Billing in your account; cancellation takes effect at the end of the current period and you keep your plan until then. Subscription credits are added once a month (yearly plans receive them month by month), expire at the end of that month and do not roll over.'
                : '',
            ].filter(Boolean),
          },
          { h: 'Availability and liability', p: ['We work to keep the service available but provide it as is. To the extent permitted by law, our liability is limited to the amount you paid in the 12 months before a claim.'] },
          { h: 'Changes', p: ['We may update these terms. Continued use after an update means you accept the new terms.'] },
        ],
      },
      refund: {
        title: 'Refund Policy',
        sections: [
          { h: 'Failed renders', p: ['If a video fails to render, the credits are returned to your balance automatically. No action is needed.'] },
          { h: 'Unused credits', p: [`You can request a refund of a credit pack within 14 days of purchase if none of its credits have been used. Email ${s.supportEmail} with your order ID.`] },
          ...(subs
            ? [
                {
                  h: 'Subscriptions',
                  p: [
                    `You can request a refund of a subscription payment within 14 days of the charge if none of its credits have been used. Email ${s.supportEmail} with the order ID from Billing. Refunded credits are removed from your balance.`,
                    'Canceling stops future renewals. The current period is not refunded automatically, and you keep your plan until it ends.',
                  ],
                },
              ]
            : []),
          { h: 'Quality issues', p: ['If a finished video is clearly broken (for example corrupted or missing the face), contact us with the video ID and we will restore the credits after review.'] },
          { h: 'How refunds are paid', p: ['Approved refunds go back to the original payment method through our payment partner and may take 5–10 business days to appear.'] },
        ],
      },
    },
    articles: {
      trend: {
        title: `What is the ${k} trend?`,
        description: `Where the ${k} clip came from, why it spread and how to join in with an AI version of yourself.`,
        intro: `The ${k} clip is a short vertical dance video that turned into a template: people re-create the same routine, beat for beat, and post their own version.`,
        sections: [
          { h: 'Why it caught on', p: ['The routine is short, the timing is easy to recognise and the camera work is simple enough that the performer is always the focus. That makes every new version feel like a fresh take on the same joke.'] },
          { h: 'How people join in', p: ['Some learn the steps and film themselves. Others use AI to place themselves in the original clip, which keeps the exact timing and camera moves without filming anything.'] },
          { h: 'Do it with AI', p: [`With ${b} you upload one photo and receive a vertical video in which you perform the routine. Choose a short hook or the full length and share it straight away.`] },
        ],
      },
      howTo: {
        title: `How to make a ${k} AI video`,
        description: `A step-by-step guide to making your own ${k} video from a single photo.`,
        intro: `You can create your own ${k} video in about five minutes. Here is the full process and a few tips for the best result.`,
        sections: [
          { h: '1. Pick the right photo', p: ['Choose a recent, sharp photo of one person looking at the camera. Even daylight works best. Avoid sunglasses, hats that cover the face and beauty filters.'] },
          { h: '2. Upload and choose a length', p: ['Sign in, drop the photo into the generator and pick a length. Shorter clips render faster and cost fewer credits; the full version follows the complete routine.'] },
          { h: '3. Confirm consent and generate', p: ['Tick the consent box to confirm the photo is yours or that you have permission, then start the render. You can leave the page while it works.'] },
          { h: '4. Download and share', p: ['When the video is ready, download the MP4 from the generator or from My videos and post it wherever you like.'] },
        ],
      },
    } satisfies Record<ArticleKey, ArticleContent>,
  }
}

export type Content = ReturnType<typeof en>
