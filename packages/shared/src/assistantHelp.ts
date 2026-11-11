/**
 * Texts for the "use your own AI assistant" help in the apps (web and native
 * show the same): setup steps and example questions per place in the app.
 * Product-neutral on purpose: product-specific steps are in the guide.
 */
export type AssistantHelpTopic = 'route' | 'aircraft' | 'aerodrome' | 'logbook' | 'general'

export const ASSISTANT_STEPS: readonly string[] = [
  'In your AI assistant, add a custom connector (remote MCP server) with the address below.',
  'The assistant opens OpenVFR: sign in if asked, then choose what it may read or change.',
  'Ask your question in the assistant, typed or spoken.',
]

export const ASSISTANT_EXAMPLES: Record<AssistantHelpTopic, readonly string[]> = {
  route: [
    'Brief my saved route to Visby for tomorrow at 09:00.',
    'Which altitudes should I fly on this route? Stay below the TMAs where terrain allows.',
    'Plan ESSB to ESMS with a fuel stop and save it.',
    'Is there a way around the control zone on leg 2?',
  ],
  aircraft: [
    'Add a new aircraft SE-ABC, a Cessna 182, from the attached POH.',
    "Set SE-ABC's maximum crosswind to 15 kt.",
  ],
  aerodrome: [
    "What's the weather and are there NOTAMs at ESKN?",
    'Is the crosswind at ESGG OK for my aircraft right now?',
    'Where can I refuel on my route to Umeå?',
  ],
  logbook: [
    'How many hours have I flown in the last 90 days?',
    'When was my last flight, and with which aircraft?',
  ],
  general: [
    'Brief my saved route Bromma to Malmö.',
    'Save my cabin at 59.50 17.93 as a place and plan a route there.',
  ],
}

export const ASSISTANT_DISCLAIMER = 'The assistant\'s answers are a planning aid, not an official briefing. Check the official AIP, NOTAM and weather sources before every flight.'

/** Examples for a topic, topped up with the general ones, at most `max`. */
export function assistantExamples(topic: AssistantHelpTopic, max = 4): string[] {
  return [...ASSISTANT_EXAMPLES[topic], ...(topic === 'general' ? [] : ASSISTANT_EXAMPLES.general)].slice(0, max)
}
