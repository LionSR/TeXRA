// Default theme
import DefaultTheme from 'vitepress/theme';
import LaunchPage from '../components/LaunchPage.vue';

export default {
  ...DefaultTheme,
  enhanceApp({ app }) {
    // Register custom components
    app.component('LaunchPage', LaunchPage);
  },
};
