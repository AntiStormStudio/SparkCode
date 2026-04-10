const agentsPlatform = {
  name: 'agents-platform',
  type: 'local',
  description: '在恢复版开发构建中不可用。',
  supportsNonInteractive: true,
  load: async () => ({
    async call() {
      return { type: 'skip' as const }
    },
  }),
}

export default agentsPlatform
