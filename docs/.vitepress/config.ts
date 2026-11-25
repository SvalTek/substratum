import { defineConfig } from 'vitepress';

const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.DOCS_BASE ?? (process.env.GITHUB_ACTIONS && repo ? `/${repo}/` : '/');

export default defineConfig({
  title: 'Substratum',
  description: 'A reactive spatial runtime for composable systems.',
  base,
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Architecture', link: '/guide/architecture' },
      { text: 'API', link: '/api/' },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/SvalTek/substratum' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Spatial Model', link: '/guide/spatial-model' },
          { text: 'Reactivity & Events', link: '/guide/reactivity' },
          { text: 'Middleware & Plugins', link: '/guide/middleware-and-plugins' },
          { text: 'Transactions', link: '/guide/transactions' },
          { text: 'Architecture & Limits', link: '/guide/architecture' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API Reference', link: '/api/' },
        ],
      },
    ],

    search: {
      provider: 'local',
    },

    outline: {
      level: [2, 3],
    },

    footer: {
      message: 'Substratum — A reactive spatial runtime for composable systems.',
    },
  },
});
