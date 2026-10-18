document.querySelector("#publish-form").addEventListener("submit", async event => {
  event.preventDefault();
  const result = document.querySelector("#result");
  result.textContent = "Publishing…";
  try {
    const bundle = JSON.parse(await document.querySelector("#bundle").files[0].text());
    const response = await fetch("/api/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${document.querySelector("#token").value}` },
      body: JSON.stringify(bundle)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Publishing failed");
    result.innerHTML = `Public link: <a href="${data.page}">${data.page}</a>`;
  } catch (error) {
    result.textContent = error.message;
  }
});
