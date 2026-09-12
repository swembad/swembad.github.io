function generateURL() {
    const timestamp = Math.floor(Date.now() / 1000);
    const url = `https://swembad.github.io/attachments/content.html?=${timestamp}`;
    document.getElementById('output').textContent = url;
}