/**
 * Dev-only tool: lists the Claude models this ANTHROPIC_API_KEY can actually
 * reach, so ANTHROPIC_MODEL is chosen against a live catalogue rather than a
 * guessed id. Free — it calls the Models API, not a model.
 *   npx tsx --env-file=.env.local scripts/list-anthropic-models.ts
 * Never imported by production code.
 */
import Anthropic from "@anthropic-ai/sdk"

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const models: { id: string; name: string }[] = []
  // Auto-paginates.
  for await (const model of client.models.list()) {
    models.push({ id: model.id, name: model.display_name })
  }
  console.log(`Models visible to this key: ${models.length}\n`)
  for (const m of models) console.log(`  ${m.id.padEnd(32)} ${m.name}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
