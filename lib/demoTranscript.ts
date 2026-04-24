export interface DemoChunk {
  text: string;
  durationMs: number;
}

export const DEMO_TRANSCRIPT: DemoChunk[] = [
  {
    text:
      "So we're talking about how to scale our backend to handle a million concurrent users. Right now we're running on a single region and seeing degraded performance above 200k.",
    durationMs: 30000,
  },
  {
    text:
      "The main bottleneck is websocket connections and how we're handling state in memory. Each box holds sessions for its connected users and that doesn't shard cleanly.",
    durationMs: 30000,
  },
  {
    text:
      "I read that companies like Discord shard by guild ID. Should we do something similar and shard by user cohort so presence data stays co-located?",
    durationMs: 30000,
  },
  {
    text:
      "Also concerned about cost. If we move to managed Kafka, what's a realistic monthly bill at our volume? We're processing around one million events per second peak.",
    durationMs: 30000,
  },
  {
    text:
      "And one more thing — what was the failure mode when Slack went down last year? I want to avoid that same config-push pattern. Was that capacity or a bad deploy?",
    durationMs: 30000,
  },
  {
    text:
      "Our p99 latency on websocket round-trips is about 180ms today, which is borderline. We want under 120ms. Part of that is cross-region hops from our Kafka cluster in us-east.",
    durationMs: 30000,
  },
  {
    text:
      "Someone suggested Elixir for the socket layer because it's what Discord and WhatsApp use. But we don't have Elixir expertise in-house. Is the rewrite worth it or can we squeeze more out of Node?",
    durationMs: 30000,
  },
  {
    text:
      "Another option is to co-locate presence in Redis Cluster with consistent hashing on user ID. That's cheaper than a rewrite. What's the upper bound of ops per second per node on a decent EC2 box?",
    durationMs: 30000,
  },
];
