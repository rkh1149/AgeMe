const controls = {
  form: document.getElementById("controls"),
  apiUrl: document.getElementById("apiUrl"),
  photo: document.getElementById("photo"),
  ageDelta: document.getElementById("ageDelta"),
  intensity: document.getElementById("intensity"),
  hairColor: document.getElementById("hairColor"),
  glasses: document.getElementById("glasses"),
  baldness: document.getElementById("baldness"),
  blemishFix: document.getElementById("blemishFix"),
  skinTexture: document.getElementById("skinTexture"),
  quality: document.getElementById("quality"),
  preserveIdentity: document.getElementById("preserveIdentity"),
  regenerateBtn: document.getElementById("regenerateBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  compareSlider: document.getElementById("compareSlider"),
  afterMask: document.getElementById("afterMask"),
  beforeImage: document.getElementById("beforeImage"),
  afterImage: document.getElementById("afterImage"),
  status: document.getElementById("status"),
  ageDeltaValue: document.getElementById("ageDeltaValue"),
  intensityValue: document.getElementById("intensityValue"),
  baldnessValue: document.getElementById("baldnessValue"),
  blemishFixValue: document.getElementById("blemishFixValue"),
  skinTextureValue: document.getElementById("skinTextureValue")
};

const state = {
  sourceFile: null,
  uploadFile: null,
  beforeObjectUrl: "",
  afterDataUrl: ""
};

function setStatus(message) {
  controls.status.textContent = message;
}

function setSliderLabels() {
  controls.ageDeltaValue.textContent = controls.ageDelta.value;
  controls.intensityValue.textContent = Number(controls.intensity.value).toFixed(2);
  controls.baldnessValue.textContent = controls.baldness.value;
  controls.blemishFixValue.textContent = controls.blemishFix.value;
  controls.skinTextureValue.textContent = controls.skinTexture.value;
}

function updateCompareMask() {
  controls.afterMask.style.width = `${controls.compareSlider.value}%`;
}

function clearGeneratedState() {
  state.afterDataUrl = "";
  controls.afterImage.src = "";
  controls.downloadBtn.disabled = true;
  controls.regenerateBtn.disabled = true;
}

function loadImageFromObjectUrl(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not decode uploaded image."));
    };
    image.src = objectUrl;
  });
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to re-encode image for upload."));
        return;
      }
      resolve(blob);
    }, "image/jpeg", quality);
  });
}

async function normalizeUploadImage(file) {
  const image = await loadImageFromObjectUrl(file);
  const maxEdge = 2048;
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not prepare image for upload.");
  }

  context.drawImage(image, 0, 0, targetWidth, targetHeight);
  const blob = await canvasToJpegBlob(canvas, 0.92);

  const normalizedName = (file.name || "upload")
    .replace(/\.[a-z0-9]+$/i, "")
    .concat(".jpg");

  return new File([blob], normalizedName, { type: "image/jpeg" });
}

async function onPhotoChange() {
  const file = controls.photo.files?.[0];
  clearGeneratedState();

  if (!file) {
    setStatus("Select a photo to start.");
    controls.beforeImage.src = "";
    state.sourceFile = null;
    state.uploadFile = null;
    return;
  }

  if (!file.type.startsWith("image/")) {
    setStatus("Please upload a valid image file.");
    controls.photo.value = "";
    return;
  }

  if (file.size > 8 * 1024 * 1024) {
    setStatus("File exceeds 8 MB. Please use a smaller image.");
    controls.photo.value = "";
    return;
  }

  state.sourceFile = file;
  if (state.beforeObjectUrl) {
    URL.revokeObjectURL(state.beforeObjectUrl);
  }

  state.beforeObjectUrl = URL.createObjectURL(file);
  controls.beforeImage.src = state.beforeObjectUrl;
  controls.afterImage.src = state.beforeObjectUrl;

  try {
    setStatus("Preparing image for generation...");
    state.uploadFile = await normalizeUploadImage(file);
    setStatus("Photo loaded. Adjust settings and click Generate.");
  } catch (error) {
    state.uploadFile = file;
    const message = error instanceof Error ? error.message : "Image preparation failed.";
    setStatus(`Photo loaded. Using original upload (${message})`);
  }
}

function buildParams() {
  return {
    age_delta: Number(controls.ageDelta.value),
    intensity: Number(controls.intensity.value),
    hair_color: controls.hairColor.value,
    glasses: controls.glasses.value,
    baldness: Number(controls.baldness.value),
    blemish_fix: Number(controls.blemishFix.value),
    skin_texture: Number(controls.skinTexture.value),
    quality: controls.quality.value,
    preserve_identity: controls.preserveIdentity.checked
  };
}

function normalizeImageDataUrl(body) {
  if (typeof body.image_data_url === "string" && body.image_data_url.startsWith("data:image/")) {
    return body.image_data_url;
  }

  let base64 = "";
  if (typeof body.image_base64 === "string") {
    base64 = body.image_base64.trim();
  }

  if (base64.startsWith("data:image/")) {
    return base64;
  }

  if (!base64) {
    throw new Error("No image data was returned by the API.");
  }

  const mime = typeof body.mime_type === "string" && body.mime_type.startsWith("image/")
    ? body.mime_type
    : "image/png";

  const normalizedBase64 = base64.replace(/\s+/g, "");
  return `data:${mime};base64,${normalizedBase64}`;
}

function setAfterImageSource(dataUrl) {
  return new Promise((resolve, reject) => {
    controls.afterImage.onload = () => resolve();
    controls.afterImage.onerror = () => reject(new Error("Generated image could not be decoded by the browser."));
    controls.afterImage.src = dataUrl;
  });
}

async function generateImage() {
  const uploadFile = state.uploadFile || state.sourceFile;
  if (!uploadFile) {
    setStatus("Please choose a photo first.");
    return;
  }

  const apiUrl = controls.apiUrl.value.trim();
  if (!apiUrl) {
    setStatus("Set your API endpoint first.");
    return;
  }

  const params = buildParams();
  const payload = new FormData();
  payload.append("image", uploadFile, uploadFile.name);
  payload.append("params", JSON.stringify(params));

  setStatus("Generating image...");
  controls.form.querySelector("button[type='submit']").disabled = true;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      body: payload
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error?.message || "Generation failed.");
    }

    const dataUrl = normalizeImageDataUrl(body);
    await setAfterImageSource(dataUrl);
    state.afterDataUrl = dataUrl;

    controls.downloadBtn.disabled = false;
    controls.regenerateBtn.disabled = false;
    setStatus("Done. Use slider to compare before and after.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    setStatus(`Error: ${message}`);
  } finally {
    controls.form.querySelector("button[type='submit']").disabled = false;
  }
}

function downloadImage() {
  if (!state.afterDataUrl) {
    return;
  }

  const a = document.createElement("a");
  a.href = state.afterDataUrl;
  a.download = `ageme-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

controls.form.addEventListener("submit", (event) => {
  event.preventDefault();
  generateImage();
});

controls.regenerateBtn.addEventListener("click", generateImage);
controls.downloadBtn.addEventListener("click", downloadImage);
controls.photo.addEventListener("change", onPhotoChange);
controls.compareSlider.addEventListener("input", updateCompareMask);
controls.ageDelta.addEventListener("input", setSliderLabels);
controls.intensity.addEventListener("input", setSliderLabels);
controls.baldness.addEventListener("input", setSliderLabels);
controls.blemishFix.addEventListener("input", setSliderLabels);
controls.skinTexture.addEventListener("input", setSliderLabels);

setSliderLabels();
updateCompareMask();
