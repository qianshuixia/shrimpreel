import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { anchorPrice, formatPrice, packageMakes, sellingPlans, site, type SubscriptionPlan } from '#/config/site'
import { useCheckout } from '#/lib/checkout'
import { useContent } from '#/lib/i18n'
import { ErrorText, Spinner } from './ui'

export function Pricing() {
  const c = useContent()
  const p = c.pricing
  const { buy, pending, error, checkoutPaused, paused, loading } = useCheckout()

  function buyButton(id: string, primary: boolean, label: string) {
    return (
      <button
        type="button"
        onClick={() => buy(id)}
        // 会话还在加载时 user 为空，此时点击会把已登录用户误送去登录页
        disabled={pending !== null || loading || paused}
        className={`${primary ? 'btn-primary' : 'btn-ghost'} mt-auto w-full`}
        data-testid={`buy-${id}`}
      >
        {paused ? (
          <span>{p.paused}</span>
        ) : pending === id ? (
          <>
            <Spinner /> <span>{p.buying}</span>
          </>
        ) : (
          <span>{label}</span>
        )}
      </button>
    )
  }

  // 按包数自适应列数；类名必须是完整字面量，Tailwind 才扫得到
  const packCount: number = site.packages.length
  const gridCols = packCount === 4 ? 'md:grid-cols-2 lg:grid-cols-4' : packCount === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3'

  return (
    <div className="space-y-6">
      {checkoutPaused ? (
        <p role="status" className="mx-auto max-w-2xl rounded-xl bg-amber-100 px-4 py-3 text-center text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-200" data-testid="checkout-paused">
          {p.pausedNote}
        </p>
      ) : null}
      {sellingPlans.length ? (
        <>
          <div className="mx-auto max-w-2xl text-center">
            <h3 className="font-display text-2xl">{p.plansTitle}</h3>
            <p className="mt-2 text-sm text-muted">{p.plansBody}</p>
          </div>
          <div className="mx-auto grid max-w-3xl gap-5 md:grid-cols-2">
            {sellingPlans.map((plan) => (
              <PlanCard key={plan.id} plan={plan} button={buyButton(plan.id, !!plan.highlight, p.subscribe)} />
            ))}
          </div>
          <p className="text-center text-xs text-muted">{p.renewalNote}</p>
          <h3 className="pt-6 text-center font-display text-2xl">{p.packsTitle}</h3>
        </>
      ) : null}
      <div className={`grid gap-5 ${gridCols}`}>
        {site.packages.map((pack) => {
          const info = p.packages[pack.id] ?? { name: pack.id, tagline: '' }
          const highlight = 'highlight' in pack && pack.highlight
          const anchor = anchorPrice(pack)
          const makes = packageMakes(pack.credits)
          return (
            <div
              key={pack.id}
              className={`card relative flex flex-col p-6 ${highlight ? 'ring-2 ring-ink md:-translate-y-2' : ''}`}
              data-testid={`package-${pack.id}`}
            >
              {highlight ? (
                <span className="absolute -top-3 left-6 rounded-full bg-ink px-3 py-1 text-xs font-semibold text-ink-fg">{p.popular}</span>
              ) : null}
              <h3 className="font-display text-2xl">{info.name}</h3>
              <p className="mt-1 text-sm text-muted">{info.tagline}</p>
              <p className="mt-6 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-display text-4xl">{formatPrice(pack.priceCents, pack.currency)}</span>
                {anchor ? (
                  <>
                    <s className="text-lg text-muted" data-testid={`anchor-${pack.id}`}>
                      <span className="sr-only">{p.was} </span>
                      {formatPrice(anchor.cents, pack.currency)}
                    </s>
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">{p.save(anchor.percentOff)}</span>
                  </>
                ) : null}
              </p>
              <p className="mt-1 text-sm font-semibold">{p.credits(pack.credits)}</p>
              {makes.length ? <p className="text-xs text-muted">{p.makes(makes)}</p> : null}
              <ul className="my-6 space-y-2.5 text-sm">
                {p.bullets.map((bullet) => (
                  <li key={bullet} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" /> <span>{bullet}</span>
                  </li>
                ))}
              </ul>
              {buyButton(pack.id, !!highlight, p.buy)}
            </div>
          )
        })}
      </div>
      <ErrorText code={error} />
      <p className="text-center text-xs text-muted">{p.note}</p>
    </div>
  )
}

// 年付相对“同积分、同币种月付 × 12”省多少（百分比），没有可比的月付时不显示
function yearlySaving(plan: SubscriptionPlan) {
  if (plan.interval !== 'year') return null
  const monthly = site.plans.find((m) => m.interval === 'month' && m.credits === plan.credits && m.currency === plan.currency)
  if (!monthly) return null
  const percent = Math.round((1 - plan.priceCents / (monthly.priceCents * 12)) * 100)
  return percent > 0 ? percent : null
}

function PlanCard({ plan, button }: { plan: SubscriptionPlan; button: ReactNode }) {
  const p = useContent().pricing
  const info = p.plans[plan.id] ?? { name: plan.id, tagline: '' }
  const saving = yearlySaving(plan)
  return (
    <div className={`card relative flex flex-col p-6 ${plan.highlight ? 'ring-2 ring-ink' : ''}`} data-testid={`plan-${plan.id}`}>
      {plan.highlight ? (
        <span className="absolute -top-3 left-6 rounded-full bg-ink px-3 py-1 text-xs font-semibold text-ink-fg">{p.popular}</span>
      ) : null}
      <h3 className="font-display text-2xl">{info.name}</h3>
      <p className="mt-1 text-sm text-muted">{info.tagline}</p>
      <p className="mt-6 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-display text-4xl">{formatPrice(plan.priceCents, plan.currency)}</span>
        <span className="text-sm text-muted">{plan.interval === 'year' ? p.perYear : p.perMonth}</span>
        {saving ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
            {p.save(saving)}
          </span>
        ) : null}
      </p>
      {plan.interval === 'year' ? (
        <p className="mt-1 text-xs text-muted">{p.yearlyMonthly(formatPrice(Math.round(plan.priceCents / 12), plan.currency))}</p>
      ) : null}
      <p className="mt-1 text-sm font-semibold">{p.monthlyCredits(plan.credits)}</p>
      <ul className="my-6 space-y-2.5 text-sm">
        {p.planBullets.map((bullet) => (
          <li key={bullet} className="flex items-start gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" /> <span>{bullet}</span>
          </li>
        ))}
      </ul>
      {button}
    </div>
  )
}
