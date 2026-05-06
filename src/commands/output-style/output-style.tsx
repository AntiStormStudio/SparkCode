import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone): Promise<undefined> {
  onDone('/output-style 已废弃。请使用 /config 修改输出样式，或在设置文件中配置。更改会在下次会话生效。', {
    display: 'system'
  });
}
