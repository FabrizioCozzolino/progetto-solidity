const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

let devices = [];
let datasets = [];
let flightDatas = [];

// 🔹 POST /device
app.post("/device", (req, res) => {
  const { pk } = req.body;
  const existing = devices.find(d => d.pk === pk);
  if (existing) {
    return res.status(400).json({ code: 1001, message: "Device già esistente" });
  }
  const id = "device-" + (devices.length + 1);
  const newDevice = { id, pk };
  devices.push(newDevice);
  res.json(newDevice);
});

// 🔹 GET /device/:deviceId
app.get("/device/:deviceId", (req, res) => {
  const device = devices.find(d => d.id === req.params.deviceId);
  if (!device) return res.status(404).json({ error: "Device non trovato" });
  res.json(device);
});

// 🔹 GET /dataset?device_id=
app.get("/dataset", (req, res) => {
  const { device_id } = req.query;
  if (device_id) {
    const ds = datasets.filter(d => d.device_id === device_id);
    return res.json(ds);
  }
  res.json(datasets);
});

// 🔹 POST /dataset
app.post("/dataset", (req, res) => {
  const id = "dataset-" + (datasets.length + 1);
  const newDs = { id, device_id: req.body.device_id, name: req.body.name, description: req.body.description, devices: [req.body.device_id] };
  datasets.push(newDs);
  res.json(newDs);
});

// 🔹 POST /flight_data
app.post("/flight_data", (req, res) => {
  const id = "fd-" + (flightDatas.length + 1);
  const newFd = { ...req.body, id };
  flightDatas.push(newFd);
  res.json(newFd);
});

// 🔹 GET /dataset/:datasetId/flight_datas
app.get("/dataset/:datasetId/flight_datas", (req, res) => {
  const fdList = flightDatas.filter(fd => fd.dataset_id === req.params.datasetId);
  res.json(fdList);
});

// Avvio server
app.listen(port, () => console.log(`✅ Mock API server in esecuzione su http://localhost:${port}`));
