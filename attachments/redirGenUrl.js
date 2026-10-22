console.log("urlGen.js loaded!");
document.addEventListener("DOMContentLoaded", () => {
    var input = document.getElementById("pastebinURLField");
    var btn = document.getElementById("genURLButton");
    var isValid = false;
    console.log("input field and button loaded!");
    input.addEventListener("input", () => {
      console.log("input field changed!");
      isValid = false;
      var changedInput = input.value;
      btn.disabled = !isValid;
      if (input && (changedInput.includes("pastebin.com/") || (changedInput.trim() !== "" && Number.isInteger(Number(changedInput))))) {
        console.log("input is valid!")
        isValid = true;
        btn.disabled = !isValid;
      }
    });
    
    function generateURL() {
      console.log(
        'your url has been generated, click the "url" button to be directly taken to the page'
      );

      var timestamp = Math.floor(Date.now() / 1000);
      var url = `https://swembad.github.io/attachments/content.html?=${timestamp}`;
      var urlOutput = document.getElementById("genOutput");
      urlOutput.href = url;
      urlOutput.style.display = "block";
    }

    btn.disabled = !isValid;

    document.getElementById("genURLButton")
        .addEventListener("click", generateURL);
});
