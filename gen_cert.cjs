const selfsigned = require('selfsigned');
const fs = require('fs');

async function main() {
  let pems;
  try {
    pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 365 });
    if (pems instanceof Promise) {
      pems = await pems;
    }
  } catch (e) {
    console.error("Error generating cert", e);
    return;
  }
  
  if (!pems || !pems.private || !pems.cert) {
    console.log("Returned:", pems);
  } else {
    fs.writeFileSync('server-key.pem', pems.private);
    fs.writeFileSync('server.pem', pems.cert);
    console.log("Certificates generated successfully.");
  }
}
main();
