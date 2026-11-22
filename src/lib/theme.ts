// 主题：site.theme 选一套，写在 <html data-skin>；颜色、字体、圆角在 src/styles.css 的 [data-skin] 里定义。
// 亮色 / 暗色由 data-theme 另外控制（访客切换），每套主题都要同时定义两种
//   classic：暖白纸张 + 品红强调、衬线标题、胶囊按钮
//   acid：锌黑 / 奶白 + 黄绿强调、无衬线粗标题、小圆角按钮
//   holiday：圣诞。霜白 / 平安夜深松绿 + 蔓越莓红强调、暖金点缀，Young Serif 标题，页头页脚格纹丝带，首屏飘雪
export const THEMES = ['classic', 'acid', 'holiday'] as const
export type ThemeName = (typeof THEMES)[number]

// <meta name="theme-color">（手机浏览器地址栏颜色），取各主题亮色模式的背景
export const THEME_COLOR: Record<ThemeName, string> = {
  classic: '#f7f4ee',
  acid: '#f5f3ee',
  holiday: '#f3f6f2',
}
