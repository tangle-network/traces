// Loaded with `node --import`: on exit, writes the process's peak resident set
// size in kilobytes to the file $MAX_RSS_OUT names, so a test can bound the
// memory a CLI run used from outside it.
import { writeFileSync } from 'node:fs'

process.on('exit', () => {
  if (process.env.MAX_RSS_OUT) writeFileSync(process.env.MAX_RSS_OUT, String(process.resourceUsage().maxRSS))
})
