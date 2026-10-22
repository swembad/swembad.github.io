document.addEventListener("DOMContentLoaded", () => {
  const WORKER = "https://media-upload-worker.difubit.workers.dev/";

  document.getElementById("uploadBtn").onclick = async () => {
    const file = document.getElementById("fileInput").files[0];
    const statusF = document.getElementById("uploadStatus");
    const url = document.getElementById("uploadURLField");
    const copy = document.getElementById("copyUploadURL");
    if (!file) {
      statusF.textContent = "please select a file to upload.";
      return;
    }

    if (file.size > 25 * 1024 * 1024) {
      statusF.textContent = "maximum file size is 25MB.";
      return;
    }

    statusF.textContent = "uploading...";
    url.value = "";

    try {
      const response = await fetch(WORKER + "upload", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });

      const result = await response.json();
      console.log("Status:", response.status);
      console.log("Response body:", result);
      console.log("Viewer URL property:", result.viewerUrl);
      if (!response.ok) {
        throw new Error(result.error || "upload failed");
      }

      url.value = result.viewerUrl;
      copy.disabled = false;
      statusF.textContent = "upload successful!";
    } catch (error) {
      statusF.textContent = error.message;
    }

    copy.onclick = async () => {
      await navigator.clipboard.writeText(url.value);
        statusF.textContent = "link copied!";
      };

  };
})