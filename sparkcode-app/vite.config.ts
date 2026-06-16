import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'sparkcode-tauri-html',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          const scripts: string[] = []
          let next = html.replace(/\s*<script type="module"([^>]*)><\/script>/g, (match) => {
            scripts.push(match.replace(/\s+crossorigin(="[^"]*")?/g, ''))
            return ''
          })
          next = next.replace(/\s+crossorigin(="[^"]*")?/g, '')
          if (scripts.length > 0) {
            next = next.replace('</body>', `${scripts.join('\n')}\n  </body>`)
          }
          return next
        },
      },
    },
  ],
  clearScreen: false,
  esbuild: {
    target: 'safari15',
  },
  build: {
    target: 'safari15',
  },
  server: {
    port: 5188,
    strictPort: true,
    host: '127.0.0.1',
  },
})
