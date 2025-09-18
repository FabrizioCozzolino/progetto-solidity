const axios = require("axios");

const API_URL = "https://digimedfor.topview.it/api/get-forest-units/";
const AUTH_TOKEN = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbl90eXBlIjoiYWNjZXNzIiwiZXhwIjoxNzU4MTg2NDgyLCJpYXQiOjE3NTgxODI4ODIsImp0aSI6ImI2YWYwYzM1MjdhNDRlZjc4ZDg5ZTRjNzU2NmE0ZDY0IiwidXNlcl9pZCI6MTE0fQ.sn1ZBa7ljk69BMJaeT6ytaFfiFGCgdUfgs2RvIti1Rk"; // il tuo token

async function testApi() {
  try {
    const response = await axios.get(API_URL, {
      headers: {
        Authorization: AUTH_TOKEN
      }
    });
    console.log(JSON.stringify(response.data, null, 2));
  } catch (e) {
    console.error("Errore API:", e.message);
  }
}

testApi();
