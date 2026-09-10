import { createApp } from 'vue'
import App from './App.vue'

// 1. 先引入 Element Plus 基础样式（浅色主题：不加载 dark css-vars，也不给 html 加 dark 类）
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// 2. 再引入应用样式：base.css 的主题变量需晚于 Element Plus 默认样式生效
import './assets/main.css'

const app = createApp(App)

// 3. 使用插件
app.use(ElementPlus)

app.mount('#app')
