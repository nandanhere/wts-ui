export function processJob(job) {
  return {
    id: job.id,
    input: job.input,
    operation: "double",
    output: job.input * 2,
  };
}
