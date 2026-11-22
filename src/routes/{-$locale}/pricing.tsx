import { createFileRoute } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Faq } from '#/components/Faq'
import { Pricing } from '#/components/Pricing'
import { Breadcrumbs, LocalLink } from '#/components/ui'
import { articlePath } from '#/config/site'
import { getContent, localeFromParam, pageHead, useContent } from '#/lib/i18n'
import { breadcrumbJsonLd, jsonLdScript } from '#/lib/seo'

// 可见面包屑与 BreadcrumbList 用同一份数据，保证结构化数据与页面内容一致
const breadcrumbItems = (c: ReturnType<typeof getContent>) => [{ name: c.nav.pricing, path: '/pricing' }]

export const Route = createFileRoute('/{-$locale}/pricing')({
  head: ({ params }) => {
    const locale = localeFromParam(params.locale)
    const c = getContent(locale)
    return {
      ...pageHead(locale, '/pricing', c.meta.pricingTitle, c.meta.pricingDescription),
      scripts: [jsonLdScript(breadcrumbJsonLd(locale, c.meta.breadcrumbHome, breadcrumbItems(c)))],
    }
  },
  component: PricingPage,
})

function PricingPage() {
  const c = useContent()
  return (
    <div className="container-page space-y-24 py-16">
      <div>
        <Breadcrumbs items={breadcrumbItems(c)} />
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <p className="eyebrow text-accent-text">{c.pricing.eyebrow}</p>
          <h1 className="mt-3 font-display text-5xl">{c.pricing.title}</h1>
          <p className="mt-4 text-muted">{c.pricing.subtitle}</p>
        </div>
        <Pricing />
        <p className="mt-8 text-center">
          <LocalLink to={articlePath('howTo')} className="inline-flex items-center gap-1.5 text-sm font-semibold hover:text-accent-text">
            {c.pricing.guide} <ArrowRight className="size-4" />
          </LocalLink>
        </p>
      </div>
      <Faq />
    </div>
  )
}
