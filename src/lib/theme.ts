// 主题：site.theme 选一套，写在 <html data-skin>；颜色、字体、圆角在 src/styles.css 的 [data-skin] 里定义。
// 亮色 / 暗色由 data-theme 另外控制（访客可切换），每套主题都要同时定义两种
//   classic：暖白纸张 + 品红强调、衬线标题、胶囊按钮
//   acid：锌黑 / 奶白 + 黄绿强调、无衬线粗标题、小圆角按钮
//   holiday：圣诞。默认平安夜深松绿暗色（可切暖雪白亮色）+ 圣诞红强调、暖金点缀，Young Serif 标题，格纹丝带，首屏景深飘雪
export const THEMES = ['classic', 'acid', 'holiday'] as const
export type ThemeName = (typeof THEMES)[number]

// 访客未手动切换过亮/暗模式时的默认行为：system 跟随系统偏好，light/dark 固定首屏默认模式
export const THEME_DEFAULT_MODE: Record<ThemeName, 'system' | 'light' | 'dark'> = {
  classic: 'system',
  acid: 'system',
  holiday: 'dark',
}

// <meta name="theme-color">（手机浏览器地址栏颜色），取各主题默认模式的背景
export const THEME_COLOR: Record<ThemeName, string> = {
  classic: '#f7f4ee',
  acid: '#f5f3ee',
  holiday: '#0b1a15',
}
