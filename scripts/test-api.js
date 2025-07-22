import axios from "axios";

const API_URL = "https://pollicino.topview.it:9443/api/get-forest-units/";
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzUzMTg1MzM0LCJpYXQiOjE3NTMxODE3MzQsImp0aSI6IjlkNjM2MmEwMzE1OTQzZWFhYzM4OWUyNjZiZGI1NTE1IiwidXNlcl9pZCI6MTEwfQ.jVOQvC_hUS30sSROhrdFxcsaTnnPIVYFR7wjocMhEec";

async function testAPI() {
  try {
    const response = await axios.get(API_URL, {
      headers: { Authorization: AUTH_TOKEN },
    });
    console.log("✅ Chiamata API riuscita!");
    console.log("Status:", response.status);
    console.log("Data ricevuti:");
    console.dir(response.data, { depth: null, colors: true });
  } catch (error) {
    console.error("❌ Errore chiamata API:");
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Body:", error.response.data);
    } else {
      console.error(error.message);
    }
  }
}

testAPI();
