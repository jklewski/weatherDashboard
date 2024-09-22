// URL of the Google Sheet in CSV format (Replace 'YOUR_SHEET_ID' with your actual Google Sheet ID)
const sheetURL = 'https://docs.google.com/spreadsheets/d/17ZaP_LAmInf3U9zOsFkX-KpC1ypWF3ZrvFiRI71pUiY/pub?output=csv';

// Fetch data from Google Sheets
fetch(sheetURL)
    .then(response => response.text())
    .then(data => {
        const parsedData = parseCSV(data);
        createPlots(parsedData);
    })
    .catch(error => {
        console.error('Error fetching data from Google Sheets:', error);
    });

// Function to parse CSV data
function parseCSV(data) {
    const rows = data.split('\n').map(row => row.split(','));
    const headers = rows[0];
    const parsedData = {
        time: [],
        temperature: [],
        humidity: [],
        windSpeed: [],
        windDir: [],
        rain: [],
        CO2: [],
    };

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.length === headers.length) {
            parsedData.time.push(row[0]);
            parsedData.temperature.push(parseFloat(row[7]));
            parsedData.humidity.push(parseFloat(row[8]));
            parsedData.windSpeed.push(parseFloat(row[9]));
            parsedData.windDir.push(parseFloat(row[10]));
            parsedData.rain.push(parseFloat(row[12]));
            parsedData.CO2.push(parseFloat(row[13]));
        }
    }
    return parsedData;
}

// Function to create the plots using Plotly.js
function createPlots(data) {
    // Trace for Temperature (Left y-axis)
    const traceTemperature = {
        x: data.time,
        y: data.temperature,
        name: 'Temperature (°C)',
        type: 'scatter',
        mode: 'lines',
        yaxis: 'y1',
        marker: { color: 'red' },
        line: {
            width: 0.5 
          }
    };
    
    // Relative Humidity Trace
    const traceHumidity = {
        x: data.time,
        y: data.humidity,
        name: 'Relative Humidity (%)',
        type: 'scatter',
        mode: 'lines',
        yaxis: 'y2',
        marker: { color: 'green' },
        line: {
            width: 0.5 
          }
    };
    
    // Rain Trace
    const traceRain = {
        x: data.time,
        y: data.rain,
        name: 'Rain (mm)',
        type: 'scatter',
        mode: 'lines',
        yaxis: 'y3',
        marker: { color: 'blue' },
        line: {
            width: 0.5 
          }
    };
        
    // Layout with 5 y-axes
    const layout = {
        autosize: true,
        xaxis: {
            title: '',
            domain: [0, 0.8]}, // Shrink x-axis domain to make space for extra y-axes on the right
        yaxis: {
            title: 'Temperature (°C)',
            side: 'left',
            position: 0,
            showgrid: false,
            range: [-10,30]
        },
        yaxis2: {
            title: 'Relative Humidity (%)',
            overlaying: 'y',
            side: 'right',
            position: 0.8,
            showgrid: false,
            range: [0,100]
        },
        yaxis3: {
            title: 'Rain (mm)',
            overlaying: 'y',
            side: 'right',
            position: 0.9,
            showgrid: false,
            range: [0,10]
        },
        legend: {
            orientation: 'h', // Set the legend to be horizontal
            x: 0.5, // Center the legend horizontally
            y: 1.2, // Position the legend above the plot (1.0 is the top of the plot)
            xanchor: 'center', // Center the legend horizontally
            yanchor: 'bottom' // Anchor the legend's bottom edge to the specified y position
        }
    };
    var config = {responsive: true}
    
    // Combine all traces into one data array
    const dataToPlot = [traceTemperature, traceHumidity, traceRain];
    
    // Render the plot
    Plotly.newPlot('plot1', dataToPlot, layout, config);

   
    // Wind Direction Trace
    const traceWindDirection = {
        x: data.time,
        y: data.windDir,
        name: 'Wind Direction (°)',
        type: 'scatter',
        mode: 'lines',
        yaxis: 'y1',
        marker: { color: 'orange' },
        line: {
            width: 0.5 
          }
    };
    
    // Wind Speed Trace
    const traceWindSpeed = {
        x: data.time,
        y: data.windSpeed,
        name: 'Wind Speed (m/s)',
        type: 'scatter',
        mode: 'lines',
        yaxis: 'y2',
        marker: { color: 'purple' },
        line: {
            width: 0.5 
          }
        
    };
    const layout2 = {
        autosize: true,
        xaxis: {
            title: '',
            domain: [0, 0.8]}, // Shrink x-axis domain to make space for extra y-axes on the right
        yaxis: {
            title: 'Wind Direction (°)',
            side: 'left',
            position: 0,
            showgrid: false,
            range: [0,360]
        },
        yaxis2: {
            title: 'Wind Speed (m/s)',
            overlaying: 'y',
            side: 'right',
            position: 0.8,
            showgrid: false,
            range: [0,10]
        },
        legend: {
            orientation: 'h', // Set the legend to be horizontal
            x: 0.5, // Center the legend horizontally
            y: 1.2, // Position the legend above the plot (1.0 is the top of the plot)
            xanchor: 'center', // Center the legend horizontally
            yanchor: 'bottom' // Anchor the legend's bottom edge to the specified y position
        }
    };
    const dataToPlot2 = [traceWindSpeed, traceWindDirection];
    Plotly.newPlot('plot2', dataToPlot2, layout2, config);

    console.log(data.CO2)
    // CO2 Trace
    const traceCO2 = {
        x: data.time,
        y: data.CO2,
        name: 'CO2',
        type: 'scatter',
        mode: 'lines',
        yaxis: 'y',
        marker: { color: 'black' },
        line: {
            width: 0.5 
          }
        
    };
    const layout3 = {
        autosize: true,
        xaxis: {
            title: '',
            domain: [0, 0.8]},
        yaxis: {
            title: 'CO2',
            side: 'left',
            position: 0,
            showgrid: false,
            range: [250,600]
        },
        legend: {
            orientation: 'h', // Set the legend to be horizontal
            x: 0.5, // Center the legend horizontally
            y: 1.2, // Position the legend above the plot (1.0 is the top of the plot)
            xanchor: 'center', // Center the legend horizontally
            yanchor: 'bottom' // Anchor the legend's bottom edge to the specified y position
        }
    };
    Plotly.newPlot('plot3', [traceCO2], layout3, config);

}