const WORKER = "https://media-upload-worker.difubit.workers.dev";
document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("redirectInputField");
  const btn = document.getElementById("redirectURLButton");
  const output = document.getElementById("redirectURLField");
  const status = document.getElementById("redirectStatus");
  const copy = document.getElementById("copyRedirectURL");
  btn.disabled = false;
  btn.addEventListener("click", async () => {
    const destination = input.value.trim();
    let parsedURL;
    try {
      parsedURL = new URL(destination);
    } catch {
      status.textContent = "please enter a valid url";
      return;
    }

    if (!["http:", "https:"].includes(parsedURL.protocol)) {
      status.textContent = "Only HTTP and HTTPS urls are allowed.";
      return;
    }

    btn.disabled = true;
    copy.disabled = true;
    output.value = "";
    status.textContent = "generating..."

    try {
      const response = await fetch(`${WORKER}/redirect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ destination: parsedURL.href })
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to generate redirect.");
      }

      output.value = result.url;
      copy.disabled = false;
      status.textContent = "redirect generated!";
    } catch (error) {
      console.error(error);
      status.textContent = error.message || "Something went wrong. Please try again later.";
    } finally {
      btn.disabled = false;
    }
  });

  copy.addEventListener("click", async () => {
    if (!output.value) return;

    try {
      await navigator.clipboard.writeText(output.value);
      status.textContent = "link copied!"
    } catch {
      output.select();
    }
  });
});