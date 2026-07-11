export async function runStreamingAggregationTest({
  title,
  createStream,
  consumeStream,
  createNonStream,
  compare,
}) {
  console.log(`=== ${title} ===\n`);

  const stream = await createStream();
  const { aggregated, count } = await consumeStream(stream);

  console.log('\n\n--- Aggregated Response ---');
  console.log('Total events received:', count);
  console.log('Aggregated response:', JSON.stringify(aggregated, null, 2));

  console.log('\n--- Non-streaming Comparison ---');
  const nonStreamResponse = await createNonStream();
  console.log(
    'Non-stream response structure:',
    JSON.stringify(nonStreamResponse, null, 2),
  );

  console.log('\n--- Validation ---');
  compare(aggregated, nonStreamResponse);
}

export function logValidation(label, value) {
  console.log(`${label}:`, value);
}
